const { main } = require('./src/strategy');
const { profileBlockArrivals } = require('./src/profiler');

// Check if flag build is set
const args = process.argv.slice(2);
const buildFlag = args[0];
if (buildFlag == '-build' || buildFlag == '-b') {
    console.log('Building zip file...');
    // Create a new zip file containing the following content:
    // - abi/*
    // - data/*.json (ignore .log files)
    // - src/*
    // index.js
    // .env
    // package.json
    // package-lock.json

    // Create a new zip file
    const fs = require('fs');
    const archiver = require('archiver');
    const output = fs.createWriteStream('build.zip');
    const archive = archiver('zip', {
        // Set max compression level
        zlib: { level: 9 },
    });
    output.on('close', () => {
        console.log(
            `Build complete. Build size: ${archive.pointer()} total bytes`
        );
    });
    archive.on('error', (err) => {
        console.log('Error building zip file. Error: ', err);
        throw err;
    });
    archive.pipe(output);
    // Add simple files to the zip
    archive.file('index.js');
    archive.file('.env');
    archive.file('package.json');
    archive.file('package-lock.json');
    archive.directory('abi', 'abi');
    archive.directory('src', 'src');

    // Add data files to the zip
    const dataFiles = fs.readdirSync('data');
    for (const dataFile of dataFiles) {
        if (dataFile.endsWith('.json')) {
            archive.file(`data/${dataFile}`, { name: `data/${dataFile}` });
        }
    }

    archive.finalize();
    return;
} else if (buildFlag == '-profileblocks' || buildFlag == '-pb') {
    let probeDuration = args[1];
    if (!probeDuration) {
        console.log('Please specify a duration in minutes.');
        return;
    }
    console.log(`Profiling block arrivals for ${probeDuration} minutes...`);
    // Profile block arrivals
    profileBlockArrivals(probeDuration * 60 * 1000);
} else if (!buildFlag) {
    // Run the bot. First, check if the .env file exists
    const dotenv = require('dotenv');
    const fs = require('fs');
    if (!fs.existsSync('.env')) {
        console.log('No .env file found. Please create one.');
        return;
    }

    // Check wether all the modules are installed
    // const { exec } = require('child_process');
    // exec('npm install', (err, stdout, stderr) => {
    //     if (err) {
    //         console.log("Error installing modules. Error: ", err);
    //         return;

    //     }
    //     console.log("Modules installed. Starting bot...");
    // });

    (async () => {
        // Start the bot by running the "main" function of strategy.js
        await main();
    })();
} else {
    console.log(
        'Invalid flag. Valid flags are: -build, -b, -profileblocks, -pb'
    );
    return;
}
