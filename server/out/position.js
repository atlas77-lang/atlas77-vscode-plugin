"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LineIndex = void 0;
class LineIndex {
    constructor(text) {
        this.lineOffsets = [];
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
    offsetToPosition(offset) {
        let low = 0;
        let high = this.lineOffsets.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.lineOffsets[mid] === offset) {
                return { line: mid, character: 0 };
            }
            else if (this.lineOffsets[mid] < offset) {
                low = mid + 1;
            }
            else {
                high = mid - 1;
            }
        }
        const line = high;
        const character = offset - this.lineOffsets[line];
        return { line, character };
    }
    spanToRange(start, end) {
        return {
            start: this.offsetToPosition(start),
            end: this.offsetToPosition(end)
        };
    }
    positionToOffset(position) {
        if (position.line >= this.lineOffsets.length) {
            return this.lineOffsets[this.lineOffsets.length - 1];
        }
        return this.lineOffsets[position.line] + position.character;
    }
}
exports.LineIndex = LineIndex;
//# sourceMappingURL=position.js.map