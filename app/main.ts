import * as fs from "node:fs";

type BencodeValue = string | number | BencodeValue[] | { [key: string]: BencodeValue };

// Decodes a single bencoded value starting at cursor.pos, advancing the cursor past it.
function decodeBencodeAt(buffer: Buffer, cursor: { pos: number }): BencodeValue {
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
        return buffer.subarray(start, cursor.pos).toString("utf8");
    } else if (firstChar === "i") {
        // Bencoded integer: i<number>e
        const endIndex = buffer.indexOf("e".charCodeAt(0), cursor.pos + 1);
        if (endIndex === -1) {
            throw new Error("Invalid bencoded integer");
        }
        const integerStr = buffer.subarray(cursor.pos + 1, endIndex).toString("ascii");
        cursor.pos = endIndex + 1;
        return parseInt(integerStr, 10);
    } else if (firstChar === "l") {
        // Bencoded list: l<bencoded_elements>e
        cursor.pos++; // skip 'l'
        const list: BencodeValue[] = [];
        while (buffer[cursor.pos] !== "e".charCodeAt(0)) {
            list.push(decodeBencodeAt(buffer, cursor));
        }
        cursor.pos++; // skip 'e'
        return list;
    } else if (firstChar === "d") {
        // Bencoded dictionary: d<key1><value1>...<keyN><valueN>e
        cursor.pos++; // skip 'd'
        const dict: { [key: string]: BencodeValue } = {};
        while (buffer[cursor.pos] !== "e".charCodeAt(0)) {
            const key = decodeBencodeAt(buffer, cursor);
            if (typeof key !== "string") {
                throw new Error("Dictionary keys must be strings");
            }
            const value = decodeBencodeAt(buffer, cursor);
            dict[key] = value;
        }
        cursor.pos++; // skip 'e'
        return dict;
    } else {
        throw new Error(`Invalid bencoded value: unexpected character '${firstChar}'`);
    }
}

function decodeBencode(buffer: Buffer): BencodeValue {
    return decodeBencodeAt(buffer, { pos: 0 });
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
    const decoded = decodeBencode(fs.readFileSync(filePath)) as { [key: string]: BencodeValue };
    const announce = decoded["announce"] as string;
    const info = decoded["info"] as { [key: string]: BencodeValue };
    const length = info["length"] as number;
    console.log(`Tracker URL: ${announce}`);
    console.log(`Length: ${length}`);
}
