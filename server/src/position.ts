import { Position, Range } from 'vscode-languageserver';

export class LineIndex {
    private lineOffsets: number[] = [];

    constructor(text: string) {
        this.lineOffsets.push(0);
        let isLineStart = false;
        
        for (let i = 0; i < text.length; i++) {
            if (isLineStart) {
                this.lineOffsets.push(i);
                isLineStart = false;
            }
            if (text[i] === '\n') {
                isLineStart = true;
            }
        }
    }

    public offsetToPosition(offset: number): Position {
        let low = 0;
        let high = this.lineOffsets.length - 1;
        
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.lineOffsets[mid] === offset) {
                return { line: mid, character: 0 };
            } else if (this.lineOffsets[mid] < offset) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        
        const line = high;
        const character = offset - this.lineOffsets[line];
        return { line, character };
    }

    public spanToRange(start: number, end: number): Range {
        return {
            start: this.offsetToPosition(start),
            end: this.offsetToPosition(end)
        };
    }

    public positionToOffset(position: Position): number {
        if (position.line >= this.lineOffsets.length) {
            return this.lineOffsets[this.lineOffsets.length - 1];
        }
        return this.lineOffsets[position.line] + position.character;
    }
}