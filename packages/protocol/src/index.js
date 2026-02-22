export function safeJsonParse(input) {
    try {
        const data = JSON.parse(input);
        if (!data || typeof data !== "object" || typeof data.type !== "string") {
            return null;
        }
        return data;
    }
    catch {
        return null;
    }
}
export function jsonStringify(message) {
    return JSON.stringify(message);
}
//# sourceMappingURL=index.js.map