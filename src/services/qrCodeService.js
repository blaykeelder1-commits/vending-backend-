const QRCode = require('qrcode');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

// Encryption settings
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = Buffer.from(process.env.QR_ENCRYPTION_KEY || '12345678901234567890123456789012', 'utf8').slice(0, 32);
const IV_LENGTH = 16;

/**
 * Encrypt QR code data
 * @param {string} text - Text to encrypt
 * @returns {string} - Encrypted text
 */
function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt QR code data
 * @param {string} text - Encrypted text
 * @returns {string} - Decrypted text
 */
function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = parts.join(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generate QR code data for a vending machine
 * @param {number} machineId - Vending machine ID
 * @returns {object} - QR code data and encrypted string
 */
async function generateQRCodeData(machineId) {
  const timestamp = Date.now();
  const uniqueId = uuidv4();

  // Create QR code payload
  const payload = {
    machineId,
    timestamp,
    uniqueId,
  };

  // Encrypt the payload
  const encryptedData = encrypt(JSON.stringify(payload));

  return {
    qrData: encryptedData,
    payload,
  };
}

/**
 * Validate and decrypt QR code data
 * @param {string} encryptedData - Encrypted QR code data
 * @returns {object} - Decrypted payload
 */
function validateQRCodeData(encryptedData) {
  try {
    const decrypted = decrypt(encryptedData);
    const payload = JSON.parse(decrypted);

    // Validate payload structure
    if (!payload.machineId || !payload.timestamp || !payload.uniqueId) {
      throw new Error('Invalid QR code format');
    }

    // Check if QR code is too old (optional - prevent replay attacks)
    const MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
    const age = Date.now() - payload.timestamp;
    if (age > MAX_AGE) {
      throw new Error('QR code expired');
    }

    return payload;
  } catch (error) {
    throw new Error('Invalid or corrupted QR code: ' + error.message);
  }
}

/**
 * Generate QR code image
 * @param {string} qrData - Data to encode in QR code
 * @param {string} outputPath - Path to save QR code image
 * @returns {string} - Path to generated QR code
 */
async function generateQRCodeImage(qrData, outputPath) {
  try {
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });

    // Generate QR code
    await QRCode.toFile(outputPath, qrData, {
      errorCorrectionLevel: 'H',
      type: 'png',
      quality: 0.95,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
      width: 300,
    });

    return outputPath;
  } catch (error) {
    throw new Error('Failed to generate QR code image: ' + error.message);
  }
}

/**
 * Generate QR code as data URL (base64)
 * @param {string} qrData - Data to encode in QR code
 * @returns {string} - Base64 data URL
 */
async function generateQRCodeDataURL(qrData) {
  try {
    const dataURL = await QRCode.toDataURL(qrData, {
      errorCorrectionLevel: 'H',
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
      width: 300,
    });

    return dataURL;
  } catch (error) {
    throw new Error('Failed to generate QR code data URL: ' + error.message);
  }
}

module.exports = {
  generateQRCodeData,
  validateQRCodeData,
  generateQRCodeImage,
  generateQRCodeDataURL,
  encrypt,
  decrypt,
};
