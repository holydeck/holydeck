// A document that lays text out, so `measure.ts`'s in-page function can be run for real rather than
// stubbed past. It wraps greedily at a fixed advance width, which is not what a font does — what is being
// proved here is the code that drives the document and reads the rects back, not Chrome's line breaking.

export interface FakeRect {
  readonly width: number;
  readonly height: number;
  readonly top: number;
}

export interface FakeNode {
  readonly style: Record<string, string>;
  textContent: string;
  getBoundingClientRect: () => FakeRect;
}

export interface FakeDocument {
  createElement: (tag: string) => FakeNode;
  createRange: () => { selectNodeContents: (node: FakeNode) => void; getClientRects: () => ArrayLike<FakeRect> };
  readonly body: { appendChild: (node: FakeNode) => unknown; removeChild: (node: FakeNode) => unknown };
  readonly fonts?: { readonly ready: Promise<unknown> };
}

export interface LayoutDocument extends FakeDocument {
  /** Nodes still attached when a measurement finished; a leak here is a leak in the real page too. */
  readonly attached: FakeNode[];
  readonly tags: string[];
}

const linesOf = (node: FakeNode): number[] => {
  const size = Number.parseFloat(node.style.fontSize ?? '0');
  const maxWidth = Number.parseFloat(node.style.width ?? '0');
  const advance = size * 0.5 + Number.parseFloat(node.style.letterSpacing ?? '0');
  const widthOf = (word: string): number => word.length * advance;

  const lines: number[] = [];
  let current = 0;
  for (const word of node.textContent.split(/\s+/u).filter(Boolean)) {
    const candidate = current === 0 ? widthOf(word) : current + widthOf(` ${word}`);
    if (current > 0 && candidate > maxWidth) {
      lines.push(current);
      current = widthOf(word);
      continue;
    }
    current = candidate;
  }
  if (current > 0) lines.push(current);
  return lines;
};

const lineHeightOf = (node: FakeNode): number =>
  Number.parseFloat(node.style.fontSize ?? '0') * Number.parseFloat(node.style.lineHeight ?? '1');

export const layoutDocument = (fonts?: { readonly ready: Promise<unknown> }): LayoutDocument => {
  const attached: FakeNode[] = [];
  const tags: string[] = [];
  let selected: FakeNode | undefined;

  return {
    attached,
    tags,
    ...(fonts === undefined ? {} : { fonts }),
    createElement: (tag: string): FakeNode => {
      tags.push(tag);
      const style: Record<string, string> = {};
      const node: FakeNode = {
        style,
        textContent: '',
        getBoundingClientRect: () => ({
          width: Math.max(...linesOf(node), 0),
          height: linesOf(node).length * lineHeightOf(node),
          top: 0,
        }),
      };
      return node;
    },
    createRange: () => ({
      selectNodeContents: (node: FakeNode) => {
        selected = node;
      },
      getClientRects: (): ArrayLike<FakeRect> => {
        const node = selected;
        if (node === undefined) return [];
        const lineHeight = lineHeightOf(node);
        return linesOf(node).map((width, index) => ({ width, height: lineHeight, top: index * lineHeight }));
      },
    }),
    body: {
      appendChild: (node: FakeNode) => attached.push(node),
      removeChild: (node: FakeNode) => attached.splice(attached.indexOf(node), 1),
    },
  };
};

export interface FakePage {
  readonly viewports: { width: number; height: number; deviceScaleFactor: number }[];
  readonly contents: string[];
  setViewport: (viewport: { width: number; height: number; deviceScaleFactor: number }) => Promise<unknown>;
  setContent: (html: string) => Promise<unknown>;
  evaluate: <A, R>(fn: (argument: A) => R, argument: A) => Promise<Awaited<R>>;
}

export const fakePage = (): FakePage => {
  const viewports: { width: number; height: number; deviceScaleFactor: number }[] = [];
  const contents: string[] = [];
  return {
    viewports,
    contents,
    setViewport: (viewport) => {
      viewports.push(viewport);
      return Promise.resolve();
    },
    setContent: (html) => {
      contents.push(html);
      return Promise.resolve();
    },
    evaluate: <A, R>(fn: (argument: A) => R, argument: A): Promise<Awaited<R>> =>
      Promise.resolve(fn(argument)) as Promise<Awaited<R>>,
  };
};

export interface FakeSession {
  readonly page: FakePage;
  readonly pages: number;
  readonly closes: number;
  newPage: () => Promise<FakePage>;
  close: () => Promise<void>;
}

export const fakeSession = (page: FakePage = fakePage()): FakeSession => {
  const session = {
    page,
    pages: 0,
    closes: 0,
    newPage: (): Promise<FakePage> => {
      session.pages += 1;
      return Promise.resolve(page);
    },
    close: (): Promise<void> => {
      session.closes += 1;
      return Promise.resolve();
    },
  };
  return session;
};

/** Installs a document for the duration of one call, the way the page would already have one. */
export const withDocument = async <T>(document: FakeDocument, run: () => Promise<T>): Promise<T> => {
  const host = globalThis as unknown as { document?: FakeDocument };
  const previous = host.document;
  host.document = document;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete host.document;
    else host.document = previous;
  }
};
