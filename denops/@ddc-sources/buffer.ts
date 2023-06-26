import {
  BaseSource,
  Context,
  DdcEvent,
  Item,
} from "https://deno.land/x/ddc_vim@v3.6.0/types.ts";
import {
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddc_vim@v3.6.0/deps.ts";
import {
  GatherArguments,
  OnEventArguments,
} from "https://deno.land/x/ddc_vim@v3.4.0/base/source.ts";
import { basename } from "https://deno.land/std@0.187.0/path/mod.ts";

type BufCache = {
  bufnr: number;
  filetype: string;
  candidates: Item[];
  bufname: string;
  changedtick: number;
};

type Params = {
  getBufnrs?: number;
  limitBytes: number;
  bufNameStyle: "none" | "full" | "basename";
};

export class Source extends BaseSource<Params> {
  private buffers: Record<number, BufCache> = {};
  override events: DdcEvent[] = [
    "BufWinEnter",
    "BufWritePost",
    "InsertEnter",
    "InsertLeave",
    "BufEnter",
  ];

  private async makeBufCache(
    denops: Denops,
    bufnr: number,
    pattern: string,
    limit: number,
  ): Promise<void> {
    const info = await getBufInfo(denops, bufnr, limit);
    if (!info) {
      return;
    }

    this.buffers[info.bufnr] = {
      bufnr: info.bufnr,
      filetype: await op.filetype.getBuffer(denops, info.bufnr),
      candidates: await gatherWords(denops, info.bufnr, pattern),
      bufname: info.name,
      changedtick: info.changedtick,
    };
  }

  private async checkCache(
    denops: Denops,
    pattern: string,
    limit: number,
    context: Context,
    id?: number,
  ): Promise<void> {
    const bufnrs = await getBufnrs(denops, context, id);

    await Promise.all(bufnrs.map(async (bufnr) => {
      if (
        !(bufnr in this.buffers) ||
        await vars.b.get(denops, "changedtick", 0) !==
          this.buffers[bufnr].changedtick
      ) {
        await this.makeBufCache(denops, bufnr, pattern, limit);
      }
    }));

    for (const _bufnr of Object.keys(this.buffers)) {
      const bufnr = Number(_bufnr);
      if (!await fn.bufloaded(denops, bufnr)) {
        delete this.buffers[bufnr];
      }
    }
  }

  override async onEvent({
    denops,
    context,
    options,
    sourceParams,
  }: OnEventArguments<Params>): Promise<void> {
    if (
      context.event == "BufEnter" &&
      (await fn.bufnr(denops) in this.buffers)
    ) {
      return;
    }

    await this.makeBufCache(
      denops,
      await fn.bufnr(denops),
      options.keywordPattern,
      sourceParams.limitBytes,
    );

    await this.checkCache(
      denops,
      options.keywordPattern,
      sourceParams.limitBytes,
      context,
      sourceParams.getBufnrs,
    );
  }

  override async gather({
    denops,
    context,
    sourceParams,
  }: GatherArguments<Params>): Promise<Item[]> {
    const bufnrs = await getBufnrs(
      denops,
      context,
      sourceParams.getBufnrs,
    );

    return Object.values(this.buffers)
      .filter((cache) => bufnrs.includes(cache.bufnr))
      .flatMap((cache): Item[] =>
        cache.candidates.map((item) => ({
          ...item,
          menu: sourceParams.bufNameStyle === "full"
            ? cache.bufname
            : sourceParams.bufNameStyle === "basename"
            ? basename(cache.bufname)
            : undefined,
        }))
      );
  }

  override params(): Params {
    return {
      limitBytes: 1e6,
      bufNameStyle: "none",
    };
  }
}

async function getBufInfo(
  denops: Denops,
  bufnr: number,
  limit: number,
) {
  await fn.bufload(denops, bufnr);
  const bufInfos = await fn.getbufinfo(denops, bufnr);
  if (bufInfos.length !== 1) {
    return;
  }
  const info = bufInfos[0];
  try {
    const stat = await Deno.stat(info.name);
    if (stat.size > limit) {
      return;
    }
  } catch {
    // File does not exist, but buffer does.
  }
  return info;
}

async function gatherWords(
  denops: Denops,
  bufnr: number,
  pattern: string,
): Promise<Item[]> {
  const regexp = new RegExp(pattern, "gu");
  const words = (await fn.getbufline(denops, bufnr, 1, "$"))
    .flatMap((line) => [...line.matchAll(regexp)])
    .map((match) => match[0])
    .filter((word) => word !== "");
  return deduplicate(words).map((word) => ({ word }));
}

async function getBufnrs(
  denops: Denops,
  context: Context,
  id?: number,
): Promise<number[]> {
  if (id !== undefined) {
    const currentBufnr = await fn.bufnr(denops);
    return (await denops.call("denops#callback#call", id, context) as number[])
      .map((bufnr) => bufnr !== 0 ? bufnr : currentBufnr);
  } else {
    return (await fn.getbufinfo(denops))
      .filter((info) => info.listed && info.loaded)
      .map((info) => info.bufnr);
  }
}

function deduplicate<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}
