import {
  BaseSource,
  Candidate,
  Context,
  DdcOptions,
  SourceOptions,
} from "https://deno.land/x/ddc_vim@v0.0.11/types.ts";
import { Denops, fn } from "https://deno.land/x/ddc_vim@v0.0.11/deps.ts";

function allWords(lines: string[]): string[] {
  return lines.flatMap((line) => [...line.matchAll(/[a-zA-Z0-9_]+/g)])
    .map((match) => match[0]).filter((e, i, self) => self.indexOf(e) === i);
}

type bufCache = {
  bufnr: number;
  filetype: string;
  candidates: Candidate[];
};

export class Source extends BaseSource {
  private buffers: bufCache[] = [];
  private limit = 1e6;
  private tabBufnrs: number[] = [];

  private async makeCache(denops: Denops, context: Context): Promise<void> {
    const endLine = await fn.line(denops, "$") as number;
    const size = (await fn.line2byte(
      denops,
      endLine + 1,
    ) as number) - 1;
    if (size > this.limit) {
      return;
    }
    const bufnr = await fn.bufnr(denops);

    this.buffers[bufnr] = {
      bufnr: bufnr,
      filetype: context.filetype,
      candidates: allWords(
        await fn.getline(denops, 1, endLine),
      ).map((word) => ({ word })),
    };
  }

  async onEvent(
    denops: Denops,
    context: Context,
    _ddcOptions: DdcOptions,
    _options: SourceOptions,
    _params: Record<string, unknown>,
  ): Promise<void> {
    await this.makeCache(denops, context);

    this.tabBufnrs = (await denops.call("tabpagebuflist") as number[]);
    this.buffers = this.buffers.filter(async (buffer) =>
      buffer.bufnr in this.tabBufnrs ||
      (await fn.buflisted(denops, buffer.bufnr))
    );
    // this.buffers = newBufnrs.map((bufnr) => this.buffers
  }

  async gatherCandidates(
    _denops: Denops,
    context: Context,
    _ddcOptions: DdcOptions,
    _options: SourceOptions,
    params: Record<string, unknown>,
  ): Promise<Candidate[]> {
    let buffers = this.buffers.filter((buf) =>
      !params.require_same_filetype || (buf.filetype != context.filetype) ||
      buf.bufnr in this.tabBufnrs
    );
    console.log(buffers);
    return buffers.map((buf) => buf.candidates).flatMap((candidate) =>
      candidate
    );
  }
}