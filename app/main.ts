import * as fs from "node:fs";
import { createHash } from "node:crypto";

type BencodeValue = string | number | BencodeValue[] | { [key: string]: BencodeValue };

// Decodes a single bencoded value starting at cursor.pos, advancing the cursor past it.
// Returns the decoded value and the position just after it.
function decodeBencodeAt(buffer: Buffer, cursor: { pos: number }): { value: BencodeValue; endPos: number } {
    const firstChar = String.fromCharCode(buffer[cursor.pos]);

    if (!isNaN(parseInt(firstChar))) {
        // Bencoded string: <length>:<string>
        const colonIndex = buffer.indexOf(":".charCodeAt(0), cursor.pos);
        if (colonIndex === -1) {
            throw new Error("Invalid bencoded string");
        }
        const length = parseInt(buffer.subarray(cursor.pos, colonIndex).toString("ascii"), 10);
        const start = colonIndex + 1;
        cursor.pos = start + length;
        return { value: buffer.subarray(start, cursor.pos).toString("utf8"), endPos: cursor.pos };
    } else if (firstChar === "i") {
        // Bencoded integer: i<number>e
        const endIndex = buffer.indexOf("e".charCodeAt(0), cursor.pos + 1);
        if (endIndex === -1) {
            throw new Error("Invalid bencoded integer");
        }
        const integerStr = buffer.subarray(cursor.pos + 1, endIndex).toString("ascii");
        cursor.pos = endIndex + 1;
        return { value: parseInt(integerStr, 10), endPos: cursor.pos };
    } else if (firstChar === "l") {
        // Bencoded list: l<bencoded_elements>e
        cursor.pos++; // skip 'l'
        const list: BencodeValue[] = [];
        while (buffer[cursor.pos] !== "e".charCodeAt(0)) {
            list.push(decodeBencodeAt(buffer, cursor).value);
        }
        cursor.pos++; // skip 'e'
        return { value: list, endPos: cursor.pos };
    } else if (firstChar === "d") {
        // Bencoded dictionary: d<key1><value1>...<keyN><valueN>e
        cursor.pos++; // skip 'd'
        const dict: { [key: string]: BencodeValue } = {};
        while (buffer[cursor.pos] !== "e".charCodeAt(0)) {
            const key = decodeBencodeAt(buffer, cursor).value;
            if (typeof key !== "string") {
                throw new Error("Dictionary keys must be strings");
            }
            const value = decodeBencodeAt(buffer, cursor).value;
            dict[key] = value;
        }
        cursor.pos++; // skip 'e'
        return { value: dict, endPos: cursor.pos };
    } else {
        throw new Error(`Invalid bencoded value: unexpected character '${firstChar}'`);
    }
}

function decodeBencode(buffer: Buffer): BencodeValue {
    return decodeBencodeAt(buffer, { pos: 0 }).value;
}

const args = process.argv;

if (args[2] === "decode") {
    // You can use print statements as follows for debugging, they'll be visible when running tests.
    console.error("Logs from your program will appear here!");

    try {
        const decoded = decodeBencode(Buffer.from(args[3], "utf8"));
        console.log(JSON.stringify(decoded));
    } catch (error) {
        console.error(error.message);
    }
} else if (args[2] === "info") {
    const filePath = args[3];
    const buffer = fs.readFileSync(filePath);

    // Walk the top-level dictionary, capturing the raw byte range of the `info` value.
    const cursor = { pos: 0 };
    cursor.pos++; // skip 'd'
    let announce = "";
    let infoStart = -1;
    let infoEnd = -1;
    while (buffer[cursor.pos] !== "e".charCodeAt(0)) {
        const key = decodeBencodeAt(buffer, cursor).value as string;
        const valueStart = cursor.pos;
        const valueResult = decodeBencodeAt(buffer, cursor);
        if (key === "announce") {
            announce = valueResult.value as string;
        } else if (key === "info") {
            infoStart = valueStart;
            infoEnd = valueResult.endPos;
        }
    }

    const infoBytes = buffer.subarray(infoStart, infoEnd);
    const infoHash = createHash("sha1").update(infoBytes).digest("hex");

    // Walk the info dictionary to get raw byte ranges for pieces
    const infoCursor = { pos: 0 };
    infoCursor.pos++; // skip 'd'
    let length = 0;
    let pieceLength = 0;
    let piecesRaw: Buffer | null = null;
    while (infoBytes[infoCursor.pos] !== "e".charCodeAt(0)) {
        const key = decodeBencodeAt(infoBytes, infoCursor).value as string;
        const valueStart = infoCursor.pos;
        const valueResult = decodeBencodeAt(infoBytes, infoCursor);
        if (key === "length") {
            length = valueResult.value as number;
        } else if (key === "piece length") {
            pieceLength = valueResult.value as number;
        } else if (key === "pieces") {
            // valueStart points to start of bencoded string (e.g., "92063:...")
            // Find the colon to skip the length prefix and get raw binary data
            const colonIdx = infoBytes.indexOf(":".charCodeAt(0), valueStart);
            piecesRaw = infoBytes.subarray(colonIdx + 1, valueResult.endPos);
        }
    }

    console.log(`Tracker URL: ${announce}`);
    console.log(`Length: ${length}`);
    console.log(`Info Hash: ${infoHash}`);
    console.log(`Piece Length: ${pieceLength}`);
    console.log("Piece Hashes:");
    if (piecesRaw) {
        for (let i = 0; i < piecesRaw.length; i += 20) {
            console.log(piecesRaw.subarray(i, i + 20).toString("hex"));
        }
    }
}
