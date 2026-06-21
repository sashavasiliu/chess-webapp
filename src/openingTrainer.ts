import { Chess, type Move, type Square } from "chess.js";

export type OpeningLineMeta = {
  id?: string;
  eco: string;
  name: string;
};

export type OpeningTrainerChild = {
  san: string;
  uci: string;
  from: Square;
  to: Square;
  promotion?: string;
  node: OpeningTrainerNode;
};

export type OpeningTrainerNode = {
  id: string;
  fen: string;
  san?: string;
  uci?: string;
  children: OpeningTrainerChild[];
  openings: OpeningLineMeta[];
};

export type OpeningTrainerTree = {
  root: OpeningTrainerNode;
  lineCount: number;
};

export type OpeningLineInput = OpeningLineMeta & {
  pgn: string;
};

const SPANISH_GAME_TSV_PATH = "/chess-openings-master/c.tsv";

export async function loadSpanishGameTree(): Promise<OpeningTrainerTree> {
  const response = await fetch(SPANISH_GAME_TSV_PATH);

  if (!response.ok) {
    throw new Error(`Could not load Spanish Game data: ${response.status} ${response.statusText}`);
  }

  return buildOpeningTree(parseSpanishGameLines(await response.text()));
}

export function buildOpeningTreeFromLine(line: OpeningLineInput): OpeningTrainerTree {
  return buildOpeningTree([line]);
}

export function parseSpanishGameLines(tsv: string): OpeningLineInput[] {
  const lines = tsv.trim().split(/\r?\n/);
  const [, ...rows] = lines;

  return rows.reduce<OpeningLineInput[]>((spanishLines, row) => {
    const [eco, name, pgn] = row.split("\t");

    if (!eco || !name || !pgn) return spanishLines;
    if (!isSpanishGameLine(eco, name)) return spanishLines;

    spanishLines.push({ eco, name, pgn });
    return spanishLines;
  }, []);
}

export function buildOpeningTree(lines: OpeningLineInput[]): OpeningTrainerTree {
  const root: OpeningTrainerNode = {
    id: "root",
    fen: new Chess().fen(),
    children: [],
    openings: [],
  };
  let parsedLineCount = 0;

  lines.forEach((line) => {
    const lineGame = new Chess();

    try {
      lineGame.loadPgn(line.pgn);
    } catch {
      return;
    }

    const replayGame = new Chess();
    let currentNode = root;

    addOpeningMeta(currentNode, line);

    for (const historicalMove of lineGame.history({ verbose: true })) {
      const move = replayGame.move(historicalMove.san);
      if (!move) return;

      currentNode = addMoveToNode(currentNode, move, replayGame.fen(), line);
    }

    parsedLineCount += 1;
  });

  return {
    root,
    lineCount: parsedLineCount,
  };
}

export function getUciForMove(move: Move) {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function isSpanishGameLine(eco: string, name: string) {
  const ecoNumber = Number(eco.slice(1));
  const isSpanishEco = eco.startsWith("C") && ecoNumber >= 60 && ecoNumber <= 99;
  const isNamedSpanishLine = name.startsWith("Ruy Lopez") || name.startsWith("Spanish Game");

  return isSpanishEco && isNamedSpanishLine;
}

function addMoveToNode(
  node: OpeningTrainerNode,
  move: Move,
  fen: string,
  opening: OpeningLineMeta,
) {
  const uci = getUciForMove(move);
  const existingChild = node.children.find((child) => child.uci === uci);

  if (existingChild) {
    addOpeningMeta(existingChild.node, opening);
    return existingChild.node;
  }

  const childNode: OpeningTrainerNode = {
    id: `${node.id}-${uci}`,
    fen,
    san: move.san,
    uci,
    children: [],
    openings: [opening],
  };

  node.children.push({
    san: move.san,
    uci,
    from: move.from,
    to: move.to,
    promotion: move.promotion,
    node: childNode,
  });

  return childNode;
}

function addOpeningMeta(node: OpeningTrainerNode, opening: OpeningLineMeta) {
  if (node.openings.some((candidate) => candidate.eco === opening.eco && candidate.name === opening.name)) {
    return;
  }

  node.openings.push({ id: opening.id, eco: opening.eco, name: opening.name });
}
