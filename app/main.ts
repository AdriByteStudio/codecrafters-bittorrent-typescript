type BencodeValue = string | number | BencodeValue[] | { [key: string]: BencodeValue };

// Decodes a single bencoded value starting at cursor.pos, advancing the cursor past it.
function decodeBencodeAt(bencodedValue: string, cursor: { pos: number }): BencodeValue {
    const firstChar = bencodedValue[cursor.pos];

    if (!isNaN(parseInt(firstChar))) {
        // Bencoded string: <length>:<string>
        const colonIndex = bencodedValue.indexOf(":", cursor.pos);
        if (colonIndex === -1) {
            throw new Error("Invalid bencoded string");
        }
        const length = parseInt(bencodedValue.substring(cursor.pos, colonIndex), 10);
        const start = colonIndex + 1;
        cursor.pos = start + length;
        return bencodedValue.substring(start, cursor.pos);
    } else if (firstChar === "i") {
        // Bencoded integer: i<number>e
        const endIndex = bencodedValue.indexOf("e", cursor.pos + 1);
        if (endIndex === -1) {
            throw new Error("Invalid bencoded integer");
        }
        const integerStr = bencodedValue.substring(cursor.pos + 1, endIndex);
        cursor.pos = endIndex + 1;
        return parseInt(integerStr, 10);
    } else if (firstChar === "l") {
        // Bencoded list: l<bencoded_elements>e
        cursor.pos++; // skip 'l'
        const list: BencodeValue[] = [];
        while (bencodedValue[cursor.pos] !== "e") {
            list.push(decodeBencodeAt(bencodedValue, cursor));
        }
        cursor.pos++; // skip 'e'
        return list;
    } else if (firstChar === "d") {
        // Bencoded dictionary: d<key1><value1>...<keyN><valueN>e
        cursor.pos++; // skip 'd'
        const dict: { [key: string]: BencodeValue } = {};
        while (bencodedValue[cursor.pos] !== "e") {
            const key = decodeBencodeAt(bencodedValue, cursor);
            if (typeof key !== "string") {
                throw new Error("Dictionary keys must be strings");
            }
            const value = decodeBencodeAt(bencodedValue, cursor);
            dict[key] = value;
        }
        cursor.pos++; // skip 'e'
        return dict;
    } else {
        throw new Error(`Invalid bencoded value: unexpected character '${firstChar}'`);
    }
}

function decodeBencode(bencodedValue: string): BencodeValue {
    return decodeBencodeAt(bencodedValue, { pos: 0 });
}

const args = process.argv;
const bencodedValue = args[3];

if (args[2] === "decode") {
    // You can use print statements as follows for debugging, they'll be visible when running tests.
    console.error("Logs from your program will appear here!");

    try {
        const decoded = decodeBencode(bencodedValue);
        console.log(JSON.stringify(decoded));
    } catch (error) {
        console.error(error.message);
    }
}
