export interface DiffPart {
  type: 'same' | 'added' | 'removed';
  text: string;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
}

function push(parts: DiffPart[], type: DiffPart['type'], token: string): void {
  const last = parts[parts.length - 1];
  if (last && last.type === type) {
    last.text += ` ${token}`;
  } else {
    parts.push({ type, text: token });
  }
}

export function diffWords(a: string, b: string): DiffPart[] {
  const left = tokenize(a);
  const right = tokenize(b);

  // LCS table: lcs[i][j] = length of LCS of left[i..] and right[j..]
  const lcs: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        left[i] === right[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push(parts, 'same', left[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push(parts, 'removed', left[i]!);
      i++;
    } else {
      push(parts, 'added', right[j]!);
      j++;
    }
  }
  while (i < left.length) {
    push(parts, 'removed', left[i]!);
    i++;
  }
  while (j < right.length) {
    push(parts, 'added', right[j]!);
    j++;
  }
  return parts;
}

export function renderDiff(parts: DiffPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'removed') return `[-${part.text}-]`;
      if (part.type === 'added') return `{+${part.text}+}`;
      return part.text;
    })
    .join(' ');
}
