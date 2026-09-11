import * as fs from "node:fs";
import * as net from "node:net";
import { createHash, randomBytes } from "node:crypto";

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

interface TorrentInfo {
    announce: string;
    infoHashRaw: Buffer;
    length: number;
    pieceLength: number;
    piecesRaw: Buffer | null;
}

function parseTorrent(filePath: string): TorrentInfo {
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
    const infoHashRaw = createHash("sha1").update(infoBytes).digest();

    // Walk the info dictionary to extract fields
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
            const colonIdx = infoBytes.indexOf(":".charCodeAt(0), valueStart);
            piecesRaw = infoBytes.subarray(colonIdx + 1, valueResult.endPos);
        }
    }

    return { announce, infoHashRaw, length, pieceLength, piecesRaw };
}

function percentEncode(buf: Buffer): string {
    let result = "";
    for (const byte of buf) {
        if (
            (byte >= 0x41 && byte <= 0x5A) ||
            (byte >= 0x61 && byte <= 0x7A) ||
            (byte >= 0x30 && byte <= 0x39) ||
            byte === 0x2D || byte === 0x5F || byte === 0x2E || byte === 0x7E
        ) {
            result += String.fromCharCode(byte);
        } else {
            result += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
        }
    }
    return result;
}

function parsePeers(peersRaw: Buffer): string[] {
    const peers: string[] = [];
    for (let i = 0; i < peersRaw.length; i += 6) {
        const ip = `${peersRaw[i]}.${peersRaw[i + 1]}.${peersRaw[i + 2]}.${peersRaw[i + 3]}`;
        const port = (peersRaw[i + 4] << 8) | peersRaw[i + 5];
        peers.push(`${ip}:${port}`);
    }
    return peers;
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
    const torrent = parseTorrent(args[3]);
    console.log(`Tracker URL: ${torrent.announce}`);
    console.log(`Length: ${torrent.length}`);
    console.log(`Info Hash: ${torrent.infoHashRaw.toString("hex")}`);
    console.log(`Piece Length: ${torrent.pieceLength}`);
    console.log("Piece Hashes:");
    if (torrent.piecesRaw) {
        for (let i = 0; i < torrent.piecesRaw.length; i += 20) {
            console.log(torrent.piecesRaw.subarray(i, i + 20).toString("hex"));
        }
    }
} else if (args[2] === "peers") {
    const torrent = parseTorrent(args[3]);
    const peerId = "-TS0001-123456789012";

    const queryParams = [
        `info_hash=${percentEncode(torrent.infoHashRaw)}`,
        `peer_id=${encodeURIComponent(peerId)}`,
        "port=6881",
        "uploaded=0",
        "downloaded=0",
        `left=${torrent.length}`,
        "compact=1",
    ];
    const trackerUrl = `${torrent.announce}?${queryParams.join("&")}`;

    const response = await fetch(trackerUrl);
    const responseBody = Buffer.from(await response.arrayBuffer());

    // Walk the tracker response to get raw bytes of 'peers'
    const cursor = { pos: 0 };
    cursor.pos++; // skip 'd'
    let peersRaw: Buffer | null = null;
    while (responseBody[cursor.pos] !== "e".charCodeAt(0)) {
        const key = decodeBencodeAt(responseBody, cursor).value as string;
        const valueStart = cursor.pos;
        const valueResult = decodeBencodeAt(responseBody, cursor);
        if (key === "peers") {
            const colonIdx = responseBody.indexOf(":".charCodeAt(0), valueStart);
            peersRaw = responseBody.subarray(colonIdx + 1, valueResult.endPos);
        }
    }

    if (peersRaw) {
        for (const peer of parsePeers(peersRaw)) {
            console.log(peer);
        }
    }
} else if (args[2] === "handshake") {
    const torrent = parseTorrent(args[3]);
    const [peerHost, peerPortStr] = args[4].split(":");
    const peerPort = parseInt(peerPortStr, 10);
    const peerId = randomBytes(20);

    // Build handshake: 1 + 19 + 8 + 20 + 20 = 68 bytes
    const handshake = Buffer.alloc(68);
    handshake[0] = 19; // protocol string length
    handshake.write("BitTorrent protocol", 1); // protocol string (19 bytes)
    // reserved bytes: 8 bytes of zeros (already zero from alloc)
    torrent.infoHashRaw.copy(handshake, 28); // info hash (20 bytes)
    peerId.copy(handshake, 48); // peer id (20 bytes)

    const socket = net.createConnection(peerPort, peerHost);

    await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => {
            socket.write(handshake);
        });

        socket.on("data", (data: Buffer) => {
            // The response handshake is 68 bytes
            if (data.length >= 68) {
                const receivedPeerId = data.subarray(48, 68);
                console.log(`Peer ID: ${receivedPeerId.toString("hex")}`);
            }
            socket.end();
            resolve();
        });

        socket.on("error", (err) => {
            reject(err);
        });
    });
}
