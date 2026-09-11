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

function buildHandshake(infoHashRaw: Buffer, peerId: Buffer, extensions = false): Buffer {
    const handshake = Buffer.alloc(68);
    handshake[0] = 19; // protocol string length
    handshake.write("BitTorrent protocol", 1); // protocol string (19 bytes)
    if (extensions) {
        handshake[25] = 0x10; // set 20th bit from right (extension protocol support)
    }
    infoHashRaw.copy(handshake, 28); // info hash (20 bytes)
    peerId.copy(handshake, 48); // peer id (20 bytes)
    return handshake;
}

async function getPeersFromTracker(announce: string, infoHashRaw: Buffer, length = 0): Promise<string[]> {
    const peerId = "-TS0001-123456789012";

    const queryParams = [
        `info_hash=${percentEncode(infoHashRaw)}`,
        `peer_id=${encodeURIComponent(peerId)}`,
        "port=6881",
        "uploaded=0",
        "downloaded=0",
        `left=${length}`,
        "compact=1",
    ];
    const trackerUrl = `${announce}?${queryParams.join("&")}`;

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

    return peersRaw ? parsePeers(peersRaw) : [];
}

async function downloadPieceFromPeer(
    torrent: TorrentInfo,
    peerHost: string,
    peerPort: number,
    pieceIndex: number
): Promise<Buffer> {
    const peerId = randomBytes(20);
    const handshake = buildHandshake(torrent.infoHashRaw, peerId);

    const socket = net.createConnection(peerPort, peerHost);

    // Message queue for parsed peer messages
    const messageQueue: Buffer[] = [];
    let waiters: { resolve: (msg: Buffer) => void; reject: (err: Error) => void }[] = [];

    const pushMessage = (msg: Buffer) => {
        if (waiters.length > 0) {
            waiters.shift()!.resolve(msg);
        } else {
            messageQueue.push(msg);
        }
    };

    const nextMessage = (): Promise<Buffer> => {
        if (messageQueue.length > 0) {
            return Promise.resolve(messageQueue.shift()!);
        }
        return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
        });
    };

    // Accumulate raw socket data
    let buffer = Buffer.alloc(0);
    let handshakeReceived = false;
    let resolveHandshake: () => void;
    const handshakePromise = new Promise<void>((resolve) => {
        resolveHandshake = resolve;
    });

    socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeReceived) {
            if (buffer.length < 68) {
                return;
            }
            buffer = buffer.subarray(68);
            handshakeReceived = true;
            resolveHandshake();
        }

        // Parse complete peer messages
        while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length === 0) {
                buffer = buffer.subarray(4); // keep-alive
                continue;
            }
            if (buffer.length < 4 + length) {
                break; // incomplete message
            }
            const message = buffer.subarray(4, 4 + length);
            buffer = buffer.subarray(4 + length);
            pushMessage(message);
        }
    });

    socket.on("error", (err) => {
        while (waiters.length > 0) {
            waiters.shift()!.reject(err);
        }
    });

    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });

    socket.write(handshake);
    await handshakePromise;

    // Wait for bitfield message (id 5)
    let msg = await nextMessage();
    while (msg[0] !== 5) {
        msg = await nextMessage();
    }

    // Send interested (id 2)
    const interested = Buffer.alloc(5);
    interested.writeUInt32BE(1, 0);
    interested[4] = 2;
    socket.write(interested);

    // Wait for unchoke (id 1)
    msg = await nextMessage();
    while (msg[0] !== 1) {
        msg = await nextMessage();
    }

    // Compute this piece's length (last piece may be shorter)
    const numPieces = Math.ceil(torrent.length / torrent.pieceLength);
    const thisPieceLength =
        pieceIndex === numPieces - 1
            ? torrent.length - (numPieces - 1) * torrent.pieceLength
            : torrent.pieceLength;

    const blockSize = 16 * 1024; // 16 KiB
    const numBlocks = Math.ceil(thisPieceLength / blockSize);
    const pieceData = Buffer.alloc(thisPieceLength);
    let blocksReceived = 0;

    // Send requests for all blocks (pipelined)
    for (let begin = 0; begin < thisPieceLength; begin += blockSize) {
        const blockLength = Math.min(blockSize, thisPieceLength - begin);
        const request = Buffer.alloc(17);
        request.writeUInt32BE(13, 0); // message length
        request[4] = 6; // request id
        request.writeUInt32BE(pieceIndex, 5); // index
        request.writeUInt32BE(begin, 9); // begin
        request.writeUInt32BE(blockLength, 13); // length
        socket.write(request);
    }

    // Wait for piece messages (id 7)
    while (blocksReceived < numBlocks) {
        msg = await nextMessage();
        if (msg[0] !== 7) {
            continue;
        }
        const begin = msg.readUInt32BE(5);
        const block = msg.subarray(9);
        block.copy(pieceData, begin);
        blocksReceived++;
    }

    socket.end();
    return pieceData;
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
    const peers = await getPeersFromTracker(torrent.announce, torrent.infoHashRaw, torrent.length);
    for (const peer of peers) {
        console.log(peer);
    }
} else if (args[2] === "handshake") {
    const torrent = parseTorrent(args[3]);
    const [peerHost, peerPortStr] = args[4].split(":");
    const peerPort = parseInt(peerPortStr, 10);
    const peerId = randomBytes(20);
    const handshake = buildHandshake(torrent.infoHashRaw, peerId);

    const socket = net.createConnection(peerPort, peerHost);
    let received = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => {
            socket.write(handshake);
        });

        socket.on("data", (data: Buffer) => {
            received = Buffer.concat([received, data]);
            // The response handshake is 68 bytes
            if (received.length >= 68) {
                const receivedPeerId = received.subarray(48, 68);
                console.log(`Peer ID: ${receivedPeerId.toString("hex")}`);
                socket.end();
                resolve();
            }
        });

        socket.on("error", (err) => {
            reject(err);
        });
    });
} else if (args[2] === "download_piece") {
    const outputPath = args[4];
    const torrentPath = args[5];
    const pieceIndex = parseInt(args[6], 10);

    const torrent = parseTorrent(torrentPath);
    const peers = await getPeersFromTracker(torrent.announce, torrent.infoHashRaw, torrent.length);

    let pieceData: Buffer | null = null;
    for (const peer of peers) {
        const [peerHost, peerPortStr] = peer.split(":");
        const peerPort = parseInt(peerPortStr, 10);
        try {
            pieceData = await downloadPieceFromPeer(torrent, peerHost, peerPort, pieceIndex);
            break;
        } catch (err) {
            // Try the next peer
        }
    }

    if (!pieceData) {
        throw new Error("Failed to download piece from any peer");
    }

    // Verify the piece hash against the torrent file
    if (torrent.piecesRaw) {
        const expectedHash = torrent.piecesRaw.subarray(pieceIndex * 20, (pieceIndex + 1) * 20);
        const actualHash = createHash("sha1").update(pieceData).digest();
        if (!actualHash.equals(expectedHash)) {
            throw new Error("Piece hash mismatch");
        }
    }

    fs.writeFileSync(outputPath, pieceData);
    console.log(`Piece ${pieceIndex} downloaded to ${outputPath}`);
} else if (args[2] === "download") {
    const outputPath = args[4];
    const torrentPath = args[5];

    const torrent = parseTorrent(torrentPath);
    const peers = await getPeersFromTracker(torrent.announce, torrent.infoHashRaw, torrent.length);

    const numPieces = Math.ceil(torrent.length / torrent.pieceLength);
    const fileData = Buffer.alloc(torrent.length);

    for (let pieceIndex = 0; pieceIndex < numPieces; pieceIndex++) {
        let pieceData: Buffer | null = null;
        for (const peer of peers) {
            const [peerHost, peerPortStr] = peer.split(":");
            const peerPort = parseInt(peerPortStr, 10);
            try {
                pieceData = await downloadPieceFromPeer(torrent, peerHost, peerPort, pieceIndex);
                break;
            } catch (err) {
                // Try the next peer
            }
        }

        if (!pieceData) {
            throw new Error(`Failed to download piece ${pieceIndex} from any peer`);
        }

        // Verify the piece hash against the torrent file
        if (torrent.piecesRaw) {
            const expectedHash = torrent.piecesRaw.subarray(pieceIndex * 20, (pieceIndex + 1) * 20);
            const actualHash = createHash("sha1").update(pieceData).digest();
            if (!actualHash.equals(expectedHash)) {
                throw new Error(`Piece ${pieceIndex} hash mismatch`);
            }
        }

        pieceData.copy(fileData, pieceIndex * torrent.pieceLength);
    }

    fs.writeFileSync(outputPath, fileData);
    console.log(`Downloaded ${torrentPath} to ${outputPath}`);
} else if (args[2] === "magnet_parse") {
    const magnetLink = args[3];
    const query = magnetLink.split("?")[1];
    const params = new URLSearchParams(query);
    const xt = params.get("xt") ?? "";
    const tr = params.get("tr") ?? "";
    const infoHash = xt.replace("urn:btih:", "");
    console.log(`Tracker URL: ${tr}`);
    console.log(`Info Hash: ${infoHash}`);
} else if (args[2] === "magnet_handshake") {
    const magnetLink = args[3];
    const query = magnetLink.split("?")[1];
    const params = new URLSearchParams(query);
    const xt = params.get("xt") ?? "";
    const trackerUrl = params.get("tr") ?? "";
    const infoHashRaw = Buffer.from(xt.replace("urn:btih:", ""), "hex");
    const peerId = randomBytes(20);

    const peers = await getPeersFromTracker(trackerUrl, infoHashRaw, 1);
    const [peerHost, peerPortStr] = peers[0].split(":");
    const peerPort = parseInt(peerPortStr, 10);

    const handshake = buildHandshake(infoHashRaw, peerId, true);

    const socket = net.createConnection(peerPort, peerHost);

    // Message queue for parsed peer messages
    const messageQueue: Buffer[] = [];
    let waiters: { resolve: (msg: Buffer) => void; reject: (err: Error) => void }[] = [];

    const pushMessage = (msg: Buffer) => {
        if (waiters.length > 0) {
            waiters.shift()!.resolve(msg);
        } else {
            messageQueue.push(msg);
        }
    };

    const nextMessage = (): Promise<Buffer> => {
        if (messageQueue.length > 0) {
            return Promise.resolve(messageQueue.shift()!);
        }
        return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
        });
    };

    let buffer = Buffer.alloc(0);
    let handshakeReceived = false;
    let receivedHandshake: Buffer | null = null;
    let resolveHandshake: () => void;
    const handshakePromise = new Promise<void>((resolve) => {
        resolveHandshake = resolve;
    });

    socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeReceived) {
            if (buffer.length < 68) {
                return;
            }
            receivedHandshake = buffer.subarray(0, 68);
            buffer = buffer.subarray(68);
            handshakeReceived = true;
            resolveHandshake();
        }

        // Parse complete peer messages
        while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length === 0) {
                buffer = buffer.subarray(4); // keep-alive
                continue;
            }
            if (buffer.length < 4 + length) {
                break; // incomplete message
            }
            const message = buffer.subarray(4, 4 + length);
            buffer = buffer.subarray(4 + length);
            pushMessage(message);
        }
    });

    socket.on("error", (err) => {
        while (waiters.length > 0) {
            waiters.shift()!.reject(err);
        }
    });

    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });

    socket.write(handshake);
    await handshakePromise;

    const receivedPeerId = receivedHandshake!.subarray(48, 68);
    console.log(`Peer ID: ${receivedPeerId.toString("hex")}`);

    // Check if the peer supports extensions (20th bit from right in reserved bytes)
    const reserved = receivedHandshake!.subarray(20, 28);
    const supportsExtensions = (reserved[5] & 0x10) !== 0;

    if (supportsExtensions) {
        // Wait for bitfield message (id 5)
        let msg = await nextMessage();
        while (msg[0] !== 5) {
            msg = await nextMessage();
        }

        // Send extension handshake: {"m": {"ut_metadata": 1}}
        const utMetadataId = 1;
        const payload = Buffer.from(`d1:md11:ut_metadatai${utMetadataId}ee`, "ascii");
        const extHandshake = Buffer.alloc(6 + payload.length);
        extHandshake.writeUInt32BE(2 + payload.length, 0); // message length
        extHandshake[4] = 20; // extended message id
        extHandshake[5] = 0; // extension handshake id
        payload.copy(extHandshake, 6);
        socket.write(extHandshake);

        // Give the message time to flush before closing
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    socket.destroy();
    process.exit(0);
}
