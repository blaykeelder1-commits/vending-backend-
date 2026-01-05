const express = require('express');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { generateQRCodeData, generateQRCodeDataURL } = require('../services/qrCodeService');

const router = express.Router();

// Apply vendor authentication
router.use(protect);
router.use(restrictTo('vendor'));

/**
 * POST /api/seed/generate-test-data
 * Generate test data: 25 machines with 100 products each
 */
router.post('/generate-test-data', async (req, res) => {
  try {
    const vendorId = req.user.id;

    console.log(`Starting test data generation for vendor ${vendorId}...`);

    const createdMachines = [];
    const createdProducts = [];

    // Product categories and names for variety
    const categories = ['Snacks', 'Beverages', 'Candy', 'Healthy', 'Frozen'];
    const snackNames = ['Chips', 'Pretzels', 'Crackers', 'Popcorn', 'Nuts', 'Trail Mix', 'Cookies', 'Granola Bars'];
    const beverageNames = ['Water', 'Soda', 'Juice', 'Energy Drink', 'Tea', 'Coffee', 'Sports Drink', 'Lemonade'];
    const candyNames = ['Chocolate Bar', 'Gummy Bears', 'Mints', 'Hard Candy', 'Lollipops', 'Caramels'];
    const healthyNames = ['Protein Bar', 'Fruit Cup', 'Veggie Chips', 'Rice Cakes', 'Dried Fruit'];
    const frozenNames = ['Ice Cream', 'Frozen Yogurt', 'Popsicle', 'Ice Cream Sandwich'];

    const allProducts = [
      ...snackNames.map(name => ({ name, category: 'Snacks' })),
      ...beverageNames.map(name => ({ name, category: 'Beverages' })),
      ...candyNames.map(name => ({ name, category: 'Candy' })),
      ...healthyNames.map(name => ({ name, category: 'Healthy' })),
      ...frozenNames.map(name => ({ name, category: 'Frozen' }))
    ];

    // Create 25 machines
    for (let i = 1; i <= 25; i++) {
      const machineName = `Test Machine ${i}`;
      const locations = [
        'Building A - Lobby', 'Building B - 2nd Floor', 'Building C - Break Room',
        'Main Office', 'Cafeteria', 'Gym', 'Library', 'Conference Center',
        'East Wing', 'West Wing', 'North Campus', 'South Campus',
        'Student Center', 'Faculty Lounge', 'Research Lab', 'Parking Garage',
        'Hospital Wing', 'Mall Food Court', 'Airport Terminal', 'Train Station',
        'Shopping Center', 'Hotel Lobby', 'Convention Center', 'Sports Arena', 'City Hall'
      ];
      const location = locations[i - 1] || `Location ${i}`;

      // Create machine with temporary QR
      const tempQR = await generateQRCodeData(0);
      const machineResult = await query(
        `INSERT INTO vending_machines
         (vendor_id, machine_name, location, qr_code_data, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [vendorId, machineName, location, tempQR.qrData]
      );

      const machineId = machineResult.rows[0].id;

      // Generate proper QR code with actual machine ID
      const qrCode = await generateQRCodeData(machineId);
      const qrImageUrl = await generateQRCodeDataURL(qrCode.qrData);

      await query(
        `UPDATE vending_machines
         SET qr_code_data = $1, qr_code_image_url = $2
         WHERE id = $3`,
        [qrCode.qrData, qrImageUrl, machineId]
      );

      createdMachines.push({ id: machineId, name: machineName, location });

      console.log(`Created machine ${i}/25: ${machineName}`);
    }

    // Create 100 products
    for (let i = 1; i <= 100; i++) {
      const product = allProducts[i % allProducts.length];
      const variant = Math.ceil(i / allProducts.length);
      const productName = variant > 1 ? `${product.name} ${variant}` : product.name;
      const price = (Math.random() * 4 + 1).toFixed(2); // $1.00 - $5.00
      const category = product.category;

      const productResult = await query(
        `INSERT INTO products
         (vendor_id, product_name, price, category, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, product_name, price, category`,
        [vendorId, productName, parseFloat(price), category]
      );

      createdProducts.push(productResult.rows[0]);

      if (i % 20 === 0) {
        console.log(`Created ${i}/100 products...`);
      }
    }

    // Assign products to machines (each machine gets 20-30 random products)
    for (const machine of createdMachines) {
      const numProducts = Math.floor(Math.random() * 11) + 20; // 20-30 products per machine
      const shuffledProducts = [...createdProducts].sort(() => Math.random() - 0.5);

      for (let i = 0; i < numProducts; i++) {
        const product = shuffledProducts[i];
        const slotNumber = String.fromCharCode(65 + Math.floor(i / 10)) + (i % 10 + 1); // A1, A2...B1, B2, etc.
        const stockQuantity = Math.floor(Math.random() * 10) + 5; // 5-15 items in stock

        await query(
          `INSERT INTO machine_products (machine_id, product_id, stock_quantity, slot_number)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [machine.id, product.id, stockQuantity, slotNumber]
        );
      }
    }

    console.log('Test data generation completed!');

    res.status(201).json({
      success: true,
      message: 'Test data generated successfully',
      data: {
        machinesCreated: createdMachines.length,
        productsCreated: createdProducts.length,
        machines: createdMachines,
      },
    });
  } catch (error) {
    console.error('Error generating test data:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating test data: ' + error.message,
    });
  }
});

/**
 * DELETE /api/seed/clear-test-data
 * Clear all test data for the vendor
 */
router.delete('/clear-test-data', async (req, res) => {
  try {
    const vendorId = req.user.id;

    // Delete in order due to foreign key constraints
    await query('DELETE FROM machine_products WHERE machine_id IN (SELECT id FROM vending_machines WHERE vendor_id = $1)', [vendorId]);
    await query('DELETE FROM products WHERE vendor_id = $1', [vendorId]);
    await query('DELETE FROM vending_machines WHERE vendor_id = $1', [vendorId]);

    res.json({
      success: true,
      message: 'All vendor data cleared successfully',
    });
  } catch (error) {
    console.error('Error clearing test data:', error);
    res.status(500).json({
      success: false,
      message: 'Error clearing test data: ' + error.message,
    });
  }
});

module.exports = router;
