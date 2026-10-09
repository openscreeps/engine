/*
 * Legacy grid path finder used by `Room.findPath` / `RoomPosition.findClosestByPath` when
 * `PathFinder.use(false)` is active. Ports only the parts of `@screeps/pathfinding` 0.4.17 that
 * screeps/engine `src/game/rooms.js` uses (Grid, Node, Heuristic.chebyshev, AStarFinder,
 * DijkstraFinder with `diagonalMovement: Always`) and the binary heap of the `heap` package it
 * depends on.
 *
 * @screeps/pathfinding (fork of PathFinding.js): Copyright (c) 2011-2012 Xueqiao Xu
 * <xueqiaoxu@gmail.com>, MIT License:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * heap 0.2.x: Copyright (c) Xueqiao Xu, a port of Python's `heapq` module (Python Software
 * Foundation License).
 */

/** A grid cell. `weight` 0 is impassable, 999 marks an end node for the Dijkstra search. */
class GridNode {
    readonly x: number;
    readonly y: number;
    walkable: boolean;
    weight: number;
    g = 0;
    h: number | undefined = undefined;
    f = 0;
    opened = false;
    closed = false;
    parent: GridNode | undefined = undefined;

    constructor(x: number, y: number, walkable: boolean | undefined, weight: number) {
        this.x = x;
        this.y = y;
        this.walkable = walkable === undefined ? true : walkable;
        this.weight = weight;
    }
}

/** `heap` binary min-heap (python `heapq` algorithm) with identical sift order. */
class BinaryHeap<T> {
    readonly #cmp: (a: T, b: T) => number;
    #nodes: T[] = [];

    constructor(cmp: (a: T, b: T) => number) {
        this.#cmp = cmp;
    }

    push(item: T): void {
        this.#nodes.push(item);
        this.#siftdown(0, this.#nodes.length - 1);
    }

    pop(): T | undefined {
        const array = this.#nodes;
        const lastelt = array.pop();
        if (array.length && lastelt !== undefined) {
            const returnitem = array[0];
            array[0] = lastelt;
            this.#siftup(0);
            return returnitem;
        }
        return lastelt;
    }

    updateItem(item: T): void {
        const pos = this.#nodes.indexOf(item);
        if (pos === -1) {
            return;
        }
        this.#siftdown(0, pos);
        this.#siftup(pos);
    }

    empty(): boolean {
        return this.#nodes.length === 0;
    }

    #at(index: number): T {
        const value = this.#nodes[index];
        if (value === undefined) {
            throw new RangeError('heap index out of range');
        }
        return value;
    }

    #siftdown(startpos: number, pos: number): void {
        const array = this.#nodes;
        const newitem = this.#at(pos);
        while (pos > startpos) {
            const parentpos = (pos - 1) >> 1;
            const parent = this.#at(parentpos);
            if (this.#cmp(newitem, parent) < 0) {
                array[pos] = parent;
                pos = parentpos;
                continue;
            }
            break;
        }
        array[pos] = newitem;
    }

    #siftup(pos: number): void {
        const array = this.#nodes;
        const endpos = array.length;
        const startpos = pos;
        const newitem = this.#at(pos);
        let childpos = 2 * pos + 1;
        while (childpos < endpos) {
            const rightpos = childpos + 1;
            if (rightpos < endpos && !(this.#cmp(this.#at(childpos), this.#at(rightpos)) < 0)) {
                childpos = rightpos;
            }
            array[pos] = this.#at(childpos);
            pos = childpos;
            childpos = 2 * pos + 1;
        }
        array[pos] = newitem;
        this.#siftdown(startpos, pos);
    }
}

/** `Heuristic.chebyshev` */
export function chebyshev(dx: number, dy: number): number {
    return Math.max(dx, dy);
}

export class Grid {
    readonly width: number;
    readonly height: number;
    nodes: GridNode[][];

    /** `matrix[y][x]` holds node weights; non-zero weights also mark the node as not walkable. */
    constructor(width: number, height: number, matrix?: readonly (readonly number[])[]) {
        this.width = width;
        this.height = height;
        this.nodes = Grid.#buildNodes(width, height, matrix);
    }

    static #buildNodes(width: number, height: number, matrix: readonly (readonly number[])[] | undefined): GridNode[][] {
        const nodes: GridNode[][] = new Array<GridNode[]>(height);
        for (let i = 0; i < height; ++i) {
            const row: GridNode[] = new Array<GridNode>(width);
            for (let j = 0; j < width; ++j) {
                const weight = matrix?.[i]?.[j];
                // Upstream leaves `weight` undefined without a matrix; `undefined > 0` is false, so 0 is equivalent.
                const node = new GridNode(j, i, undefined, weight ?? 0);
                if (weight) {
                    node.walkable = false;
                }
                row[j] = node;
            }
            nodes[i] = row;
        }
        if (matrix !== undefined && (matrix.length !== height || matrix[0]?.length !== width)) {
            throw new Error('Matrix size does not fit');
        }
        return nodes;
    }

    getNodeAt(x: number, y: number): GridNode {
        const node = this.nodes[y]?.[x];
        if (!node) {
            throw new TypeError(`Cannot read properties of undefined (reading '${String(x)}')`);
        }
        return node;
    }

    isWalkableAt(x: number, y: number): boolean {
        return this.isInside(x, y) && this.getNodeAt(x, y).weight > 0;
    }

    isInside(x: number, y: number): boolean {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }

    /** Upstream ignores `walkable` and forces weight 1. */
    setWalkableAt(x: number, y: number): void {
        this.getNodeAt(x, y).weight = 1;
    }

    /** Neighbours with `DiagonalMovement.Always` (the only mode rooms.js uses). */
    getNeighbors(node: GridNode): GridNode[] {
        const { x, y } = node;
        const neighbors: GridNode[] = [];
        if (this.isWalkableAt(x, y - 1)) neighbors.push(this.getNodeAt(x, y - 1));
        if (this.isWalkableAt(x + 1, y)) neighbors.push(this.getNodeAt(x + 1, y));
        if (this.isWalkableAt(x, y + 1)) neighbors.push(this.getNodeAt(x, y + 1));
        if (this.isWalkableAt(x - 1, y)) neighbors.push(this.getNodeAt(x - 1, y));
        if (this.isWalkableAt(x - 1, y - 1)) neighbors.push(this.getNodeAt(x - 1, y - 1));
        if (this.isWalkableAt(x + 1, y - 1)) neighbors.push(this.getNodeAt(x + 1, y - 1));
        if (this.isWalkableAt(x + 1, y + 1)) neighbors.push(this.getNodeAt(x + 1, y + 1));
        if (this.isWalkableAt(x - 1, y + 1)) neighbors.push(this.getNodeAt(x - 1, y + 1));
        return neighbors;
    }

    clone(): Grid {
        const newGrid = new Grid(this.width, this.height);
        const newNodes: GridNode[][] = new Array<GridNode[]>(this.height);
        for (let i = 0; i < this.height; ++i) {
            const row: GridNode[] = new Array<GridNode>(this.width);
            for (let j = 0; j < this.width; ++j) {
                const node = this.getNodeAt(j, i);
                row[j] = new GridNode(j, i, node.walkable, node.weight);
            }
            newNodes[i] = row;
        }
        newGrid.nodes = newNodes;
        return newGrid;
    }
}

function backtrace(node: GridNode): [number, number][] {
    const path: [number, number][] = [[node.x, node.y]];
    let current = node;
    while (current.parent) {
        current = current.parent;
        path.push([current.x, current.y]);
    }
    return path.reverse();
}

export interface AStarFinderOptions {
    heuristic?: (dx: number, dy: number) => number;
    weight?: number;
    maxOpsLimit?: number | undefined;
}

/** A* finder (diagonal movement always allowed); returns the path to the closest node on failure. */
export class AStarFinder {
    heuristic: (dx: number, dy: number) => number;
    readonly weight: number;
    readonly maxOpsLimit: number | undefined;

    constructor(opt: AStarFinderOptions = {}) {
        // Upstream's default for diagonal movement is the octile heuristic.
        this.heuristic = opt.heuristic ?? octile;
        this.weight = opt.weight || 1;
        this.maxOpsLimit = opt.maxOpsLimit;
    }

    /** `endX == -999` searches for the nearest node with weight 999 (end nodes). */
    findPath(startX: number, startY: number, endX: number, endY: number, grid: Grid): [number, number][] {
        const openList = new BinaryHeap<GridNode>((a, b) => a.f - b.f);
        const startNode = grid.getNodeAt(startX, startY);
        const endNode = endX != -999 ? grid.getNodeAt(endX, endY) : null;
        const { heuristic, weight } = this;
        const abs = Math.abs;
        let closestNode = startNode;
        let ops = 0;

        startNode.g = 0;
        startNode.f = 0;
        startNode.h = endNode ? weight * heuristic(abs(startX - endX), abs(startY - endY)) : 0;

        openList.push(startNode);
        startNode.opened = true;

        while (!openList.empty()) {
            const node = openList.pop();
            if (!node) {
                break;
            }
            node.closed = true;

            if (node === endNode || node.weight == 999) {
                return backtrace(node);
            }

            ops++;
            if (this.maxOpsLimit && ops > this.maxOpsLimit) {
                break;
            }

            for (const neighbor of grid.getNeighbors(node)) {
                if (neighbor.closed) {
                    continue;
                }
                const { x, y } = neighbor;
                const ng = node.g + neighbor.weight * (x - node.x === 0 || y - node.y === 0 ? 1 : 1.00000001);

                if (!neighbor.opened || ng < neighbor.g) {
                    neighbor.g = ng;
                    const h = neighbor.h || weight * heuristic(abs(x - endX), abs(y - endY));
                    neighbor.h = h;
                    neighbor.f = neighbor.g + h;
                    neighbor.parent = node;

                    const closestH = closestNode.h ?? NaN;
                    if (h < closestH || (h === closestH && neighbor.g < closestNode.g)) {
                        closestNode = neighbor;
                    }

                    if (!neighbor.opened) {
                        openList.push(neighbor);
                        neighbor.opened = true;
                    } else {
                        openList.updateItem(neighbor);
                    }
                }
            }
        }

        return backtrace(closestNode);
    }
}

function octile(dx: number, dy: number): number {
    const F = Math.SQRT2 - 1;
    return dx < dy ? F * dx + dy : F * dy + dx;
}

/** Dijkstra: A* with a zero heuristic. */
export class DijkstraFinder extends AStarFinder {
    constructor(opt: AStarFinderOptions = {}) {
        super(opt);
        this.heuristic = () => 0;
    }
}
