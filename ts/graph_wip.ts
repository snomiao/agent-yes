#!/usr/bin/env bun --hot

import sflow from "sflow";
import pty from "./pty";
import { TerminalTextRender } from "terminal-render";
import { fromReadable, fromWritable } from "from-node-stream";
const rows = 10;
const nodes = singleton("shells", () => [
  ((p = pty.spawn("vi", ["./tmp/f1.log"], { name: "xterm", cols: 40, rows })) =>
    ({
      readable: sflow(
        new ReadableStream({
          start: (c) => {
            p.onData((e) => c.enqueue(e));
            p.onExit((e) =>
              e.exitCode === 0 ? c.close() : c.error(new Error("ExitError: " + e.exitCode)),
            );
          },
        }),
      ),
      writable: new WritableStream<string>({
        write: (chunk) => p.write(chunk),
        close: () => p.kill(),
      }),
    }) satisfies TransformStream<string, string>)(),
  // ((p = pty.spawn("vi", ["./tmp/f2.log"], { name: "xterm", cols: 40, rows })) =>
  //   ({
  //     readable: sflow(
  //       new ReadableStream({
  //         start: (c) => {
  //           p.onData((e) => c.enqueue(e));
  //           p.onExit((e) =>
  //             e.exitCode === 0 ? c.close() : c.error(new Error("ExitError: " + e.exitCode)),
  //           );
  //         },
  //       }),
  //     ),
  //     writable: new WritableStream<string>({
  //       write: (chunk) => p.write(chunk),
  //       close: () => p.kill(),
  //     }),
  //   }) satisfies TransformStream<string, string>)(),
  { readable: sflow(fromReadable(process.stdin)), writable: fromWritable(process.stdout) },
]);
if (import.meta.main) {
  process.stdin.setRawMode(true);

  nodes[1]?.readable
    .fork()
    .map((e) => e.toString())
    .pipeTo(nodes[1]?.writable!);

  await sflow(nodes.values())
    .map(async (node, i) => {
      return node.readable.fork().map((text) => ({ i, text })); // prevent consumption of original stream
    })
    .confluenceByParallel()
    .reduce(async (accum, { i, text }) => {
      accum[i] ??= new TerminalTextRender();
      accum[i].write(text);
      return accum;
    }, [])
    .forEach(async (accum) => {
      console.clear();
      accum.forEach((t, i) => {
        const tail = t.tail(rows);
        console.log(`----- SHELL ${i} -----\n\n${tail}\n\n`);
      });
    })
    .run();
}
function singleton<T>(key: string, factory: () => T): T {
  const g = globalThis as any;
  if (!g.__singleton_store__) g.__singleton_store__ = {};
  if (!g.__singleton_store__[key]) {
    g.__singleton_store__[key] = factory();
  }
  return g.__singleton_store__[key];
}
