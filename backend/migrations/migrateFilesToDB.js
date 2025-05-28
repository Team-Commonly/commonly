const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const File = require('../models/File');

dotenv.config();

// Path to the uploads directory
const uploadsDir = path.join(__dirname, '../uploads');

// Function to migrate files
async function migrateFiles() {
  console.log('Starting file migration...');

  // Check if uploads directory exists
  if (!fs.existsSync(uploadsDir)) {
    console.log('Uploads directory does not exist. Nothing to migrate.');
    process.exit(0);
    return;
  }

  // Get all files in the uploads directory
  const files = fs.readdirSync(uploadsDir);

  if (files.length === 0) {
    console.log('No files found in uploads directory. Nothing to migrate.');
    process.exit(0);
    return;
  }

  console.log(`Found ${files.length} files to migrate.`);

  await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  // Counter for migrated files
  let migratedCount = 0;

  // Iterate through each file
  for (const fileName of files) {
    try {
      const filePath = path.join(uploadsDir, fileName);

      // Skip directories
      if (fs.statSync(filePath).isDirectory()) {
        console.log(`Skipping directory: ${fileName}`);
        continue;
      }

      // Read file data
      const fileData = fs.readFileSync(filePath);

      // Get file extension
      const fileExt = path.extname(fileName).toLowerCase();

      // Determine content type based on extension (simplified)
      let contentType = 'application/octet-stream'; // Default
      if (['.jpg', '.jpeg'].includes(fileExt)) contentType = 'image/jpeg';
      else if (fileExt === '.png') contentType = 'image/png';
      else if (fileExt === '.gif') contentType = 'image/gif';
      else if (fileExt === '.webp') contentType = 'image/webp';

      // Check if file already exists in database
      const existingFile = await File.findByFileName(fileName);

      if (existingFile) {
        console.log(`File ${fileName} already exists in database. Skipping.`);
        continue;
      }

      // Create new file document
      const newFile = new File({
        fileName,
        originalName: fileName, // Original name not preserved, using file name
        contentType,
        size: fileData.length,
        data: fileData,
        uploadedBy: '000000000000000000000000', // System user ID (placeholder)
      });

      // Save to database
      await newFile.save();

      migratedCount++;
      console.log(`Migrated file ${fileName} (${migratedCount}/${files.length})`);
    } catch (error) {
      console.error(`Error migrating file ${fileName}:`, error.message);
    }
  }

  console.log(`Migration complete. Migrated ${migratedCount} files.`);
  await mongoose.disconnect();
  process.exit(0);
}

// Run migration if executed directly
if (require.main === module) {
  migrateFiles().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

module.exports = migrateFiles;
