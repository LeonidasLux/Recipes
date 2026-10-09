/* ============================================================
   菜谱照片取图队列

   照片字节只在仓库里（`images/xxx.jpg`），本机缓存没有就得去取一张回来。
   详情页一次只有一张图，直接发请求就行；**列表一屏几十条菜谱**要是同时发出去，
   手机流量和 GitHub 的限流都受不了 —— 所以取图统一走这个队列：

   · 最多 `QUEUE_LIMIT` 张同时在取，其余排队，缩略图一张一张慢慢补上；
   · 同一张图同一时间只取一次（已缓存 / 正在取 / 刚失败过都直接跳过）；
   · 详情页那种「现在就要看」的可以插队（`priority`），不必排在一屏缩略图后面；
   · 取不到（离线 / 仓库里确实没有 / 图太大）就歇一会儿再试，
     否则每次重渲染都会往仓库重发一遍。

   取回来的字节交给 `photo.ts` 写缓存（订阅者会被通知，缩略图自己换成照片）。
   ============================================================ */

import { getImage, withTimeout } from './github';
import { cachedPhoto, markPhotosUploaded, rememberPhoto } from './photo';

/** 去哪张仓库取图（就是 store 里那份同步配置里用得着的三个字段） */
export interface PhotoFetchCfg {
  repo: string;
  branch: string;
  token: string;
}

interface PhotoTask {
  path: string;
  cfg: PhotoFetchCfg;
}

/** 同时在取的图片数：两路并行，再多就是跟自己的流量和限流过不去 */
const QUEUE_LIMIT = 2;
/** 取一张图的超时（和详情页原来那条一样） */
const FETCH_TIMEOUT_MS = 25_000;
/** 失败之后的冷却时间：离线时别每次重渲染都往仓库发一遍 */
const RETRY_AFTER_MS = 60_000;

const queue: PhotoTask[] = [];
/** 正在取（已出队还没落地）的路径 */
const pending = new Set<string>();
/** 「这条路径刚刚试过、没取到」的时间点 */
const failedAt = new Map<string, number>();
let running = 0;

/**
 * 排队取一张照片。
 *
 * 已经在缓存里、正在取、或者刚失败还没过冷却期的，都直接返回 ——
 * 调用方（缩略图 / 详情页）可以放心地在每次渲染后调它，不用自己记账。
 */
export function requestPhoto(
  path: string,
  cfg: PhotoFetchCfg,
  opts: { priority?: boolean } = {},
): void {
  if (!path || !cfg?.repo || !cfg?.token) return;
  if (cachedPhoto(path)) return;
  if (pending.has(path)) return;
  const failed = failedAt.get(path);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return;

  pending.add(path);
  if (opts.priority) queue.unshift({ path, cfg });
  else queue.push({ path, cfg });
  void pump();
}

/** 有空位就把排队的取图任务放出去跑 */
async function pump(): Promise<void> {
  while (running < QUEUE_LIMIT && queue.length > 0) {
    running++;
    void take(queue.shift()!);
  }
}

async function take(task: PhotoTask): Promise<void> {
  const t = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const got = await getImage(task.cfg.repo, task.path, task.cfg.branch, task.cfg.token, t.signal);
    if (!got) {
      /* 仓库里确实没有这张（历史遗留：菜谱指着一张没传上去的图）—— 记一笔，别马上重试 */
      failedAt.set(task.path, Date.now());
      return;
    }
    rememberPhoto(task.path, got.dataUrl);
    /* 从仓库取到了 = 仓库里确实有：本机缓存紧张时它可以被淘汰 */
    markPhotosUploaded([task.path]);
    failedAt.delete(task.path);
  } catch {
    /* 离线 / 超时 / 读不回来：冷却一会儿，下次渲染或同步时再试 */
    failedAt.set(task.path, Date.now());
  } finally {
    t.done();
    pending.delete(task.path);
    running--;
    void pump();
  }
}

/** 清掉排队与失败记录（测试用：每个用例之间别互相串味） */
export function resetPhotoQueue(): void {
  queue.length = 0;
  pending.clear();
  failedAt.clear();
}
