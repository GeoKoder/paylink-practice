// Formats a a kenyan phone number to 254XXXXXXXXX
export function formatKenyanPhone(phone) {
    // Remove spaces, dashes, and parantheses
    let cleaned = phone.replace(/[\s\-()]/g, '');

    // Remove the leading +
    if (cleaned.startsWith("+")) {
        cleaned = cleaned.substring(1);
    }

    // Convert 07XX or 01XX to 2547XX or 25411XX
    if (cleaned.startsWith("0") && cleaned.length === 10) {
        cleaned = "254" + cleaned.substring(1);
    } 

    // Validate: must be 12 digits starting with 254, followed by 7 or 1
    if (/^254[17]\d{8}$/.test(cleaned)) {
        return cleaned;
    }

    return null;
}

// Check if a phone number looks like a valid kenyan phone number
export function isValidKenyanPhone(phone) {
    return formatKenyanPhone(phone) !== null;
}

// Format a phone numebr for display
export function formatPhoneForDisplay(phone) {
    if (!phone || phone.length !== 12) return phone;
    // Convert 254712345678 to 0712 345 678
    const local = "0" + phone.substring(3);
    return `${local.substring(0, 4)} ${local.substring(4, 7)} ${local.substring(7)}`; 
}