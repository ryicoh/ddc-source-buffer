import {
  BaseSource,
  Context,
  DdcEvent,
  Item,
} from "https://deno.land/x/ddc_vim@v3.7.2/types.ts";
import {
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddc_vim@v3.7.2/deps.ts";
import {
  GatherArguments,
  OnEventArguments,
} from "https://deno.land/x/ddc_vim@v3.7.2/base/source.ts";
import { convertKeywordPattern } from "https://deno.land/x/ddc_vim@v3.7.2/util.ts";
import { basename } from "https://deno.land/std@0.192.0/path/mod.ts";
import { assert, is } from "https://deno.land/x/unknownutil@v3.2.0/mod.ts";

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

type BufInfo = Pick<fn.BufInfo, typeof bufInfoFields[number]>;

const bufInfoFields = [
  "bufnr",
  "name",
  "changedtick",
  "listed",
  "loaded",
] as const satisfies ReadonlyArray<keyof fn.BufInfo>;

export class Source extends BaseSource<Params> {
  private buffers: Map<number, BufCache> = new Map();
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

    const bufPattern = await convertKeywordPattern(denops, pattern, bufnr);

    this.buffers.set(info.bufnr, {
      bufnr: info.bufnr,
      filetype: await op.filetype.getBuffer(denops, info.bufnr),
      candidates: await gatherWords(denops, info.bufnr, bufPattern),
      bufname: info.name,
      changedtick: info.changedtick,
    });
  }

  private async checkCache(
    denops: Denops,
    bufnrs: number[],
    pattern: string,
    limit: number,
  ): Promise<void> {
    await Promise.all(bufnrs.map(async (bufnr) => {
      const changedtick = this.buffers.get(bufnr)?.changedtick;
      if (
        changedtick === undefined ||
        await vars.b.get(denops, "changedtick", 0) !== changedtick
      ) {
        await this.makeBufCache(denops, bufnr, pattern, limit);
      }
    }));

    await Promise.all([...this.buffers.keys()].map(async (bufnr) => {
      if (!await fn.bufloaded(denops, bufnr)) {
        this.buffers.delete(bufnr);
      }
    }));
  }

  override async onEvent({
    denops,
    context,
    sourceOptions,
    sourceParams,
  }: OnEventArguments<Params>): Promise<void> {
    const currentBufnr = await fn.bufnr(denops);
    if (context.event == "BufEnter" && this.buffers.has(currentBufnr)) {
      return;
    }

    // Always update current buffer
    this.buffers.delete(currentBufnr);
    const bufnrs = deduplicate([
      currentBufnr,
      ...await getBufnrs(denops, context, sourceParams.getBufnrs),
    ]);

    await this.checkCache(
      denops,
      bufnrs,
      sourceOptions.keywordPattern,
      sourceParams.limitBytes,
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

    return [...this.buffers.values()]
      .filter((cache) => bufnrs.includes(cache.bufnr))
      .flatMap((cache): Item[] => {
        const menu = sourceParams.bufNameStyle === "full"
          ? cache.bufname
          : sourceParams.bufNameStyle === "basename"
          ? basename(cache.bufname)
          : undefined;
        return cache.candidates.map((item) => ({ ...item, menu }));
      });
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
): Promise<BufInfo | undefined> {
  const bufInfos = await safeGetBufInfo(denops, bufnr);
  if (bufInfos.length !== 1) {
    return;
  }
  await fn.bufload(denops, bufnr);
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
    const bufnrs = await denops.call("denops#callback#call", id, context);
    assert(bufnrs, is.ArrayOf(is.Number));
    return bufnrs.map((bufnr) => bufnr !== 0 ? bufnr : currentBufnr);
  } else {
    return (await safeGetBufInfo(denops, { buflisted: true, bufloaded: true }))
      .map((info) => info.bufnr);
  }
}

function deduplicate<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

const bufInfoMapExpr = `{_, info -> #{${
  bufInfoFields.map((field) => `${field}: info.${field}`).join(",")
}}}`;

function safeGetBufInfo(
  denops: Denops,
  buf: fn.BufNameArg | fn.GetBufInfoDictArg,
): Promise<BufInfo[]> {
  const expr = `getbufinfo(buf)->map(${bufInfoMapExpr})`;
  return denops.eval(expr, { buf }) as Promise<BufInfo[]>;
}
