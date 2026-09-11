// Examples:
// - decodeBencode("5:hello") -> "hello"
// - decodeBencode("10:hello12345") -> "hello12345"
// - decodeBencode("i52e") -> 52
// - decodeBencode("i-52e") -> -52
function decodeBencode(bencodedValue: string): string | number {
    // Check if the first character is a digit (bencoded string)
    if (!isNaN(parseInt(bencodedValue[0]))) {
        const firstColonIndex = bencodedValue.indexOf(":");
        if (firstColonIndex === -1) {
            throw new Error("Invalid encoded value");
        }
        return bencodedValue.substring(firstColonIndex + 1);
    } else if (bencodedValue[0] === "i") {
        // Bencoded integer: i<number>e
        const endIndex = bencodedValue.indexOf("e", 1);
        if (endIndex === -1) {
            throw new Error("Invalid bencoded integer");
        }
        const integerStr = bencodedValue.substring(1, endIndex);
        return parseInt(integerStr, 10);
    } else {
        throw new Error("Only strings and integers are supported at the moment");
    }
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
