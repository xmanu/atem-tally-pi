const bonjour = require("bonjour")();
const config = require("./config");
const exec = require("child_process").exec;
const fs = require('fs');
const os = require('os');
const LocalStorage = require('node-localstorage').LocalStorage;
const pjson = require('./package.json');
const server = require('http').createServer();
const tallyio = require('socket.io-client');
const { v4: uuidv4 } = require('uuid');

const ifaces = os.networkInterfaces();
const sessionio = require('socket.io')(server);
const Blinkt = require('node-blinkt');
var leds = new Blinkt();
leds.setup()

var localStorage = new LocalStorage('./tmp');

var TallySocket;
var lastState;
var deviceId;


if (localStorage.getItem('devId')) {
    deviceId = localStorage.getItem('devId');
    console.log("Set device ID " + deviceId);
}

if (localStorage.getItem('camera')) {
    config.camera = parseInt(localStorage.getItem('camera'));
    if (isNaN(config.camera)) {
        config.camera = 1;
        localStorage.setItem('camera', 1);
    }
} else {
    config.camera = 1;
    localStorage.setItem('camera', 1);
}

const setDevId = function() {
    console.log("Generating new ID");
    var newid = uuidv4();
    localStorage.setItem('devId', newid);
    return newid;
}

const getDevId = function() {
    if (!deviceId || deviceId === null) {
        deviceId = setDevId();
    }
    return deviceId;
}

const updateTally = function() {
    leds.clearAll();
    if (!lastState.programSourceIds || !lastState.previewSourceIds)
        return;

    if (lastState.programSourceIds.includes(config.camera)) {
        leds.setAllPixels(255, 0, 0, 1.0);
    } else if (lastState.previewSourceIds.includes(config.camera)) {
        leds.setAllPixels(0, 255, 0, 1.0);
    }
    leds.sendUpdate();
}

const exitHandler = function(options, exitCode) {
    leds.clearAll();
    leds.sendUpdate();
    if (options.cleanup) console.log('clean');
    if (exitCode || exitCode === 0) console.log(exitCode);
    if (options.exit) process.exit();
}

// Based on https://github.com/fourcube/detect-rpi
const getPiModel = function() {
    var cpuInfo;

    try {
        cpuInfo = fs.readFileSync('/proc/cpuinfo', { encoding: 'utf8' });
    } catch (e) {
        // if this fails, this is probably not a pi
        return false;
    }

    var model = cpuInfo
        .split('\n')
        .map(line => line.replace(/\t/g, ''))
        .filter(line => line.length > 0)
        .map(line => line.split(':'))
        .map(pair => pair.map(entry => entry.trim()))
        .filter(pair => pair[0] === 'Hardware')

    if (!model || model.length == 0) {
        return false;
    }

    return model[0][1];
}



const publishDevice = function() {
    bonjour.publish({
        name: os.hostname(),
        type: "dsft-tally-pi",
        port: 3778,
        txt: {
            id: getDevId(),
            version: pjson.version,
            hardware: getPiModel(),
            camera: config.camera
        }
    });
}

const republishDevice = function() {
    bonjour.unpublishAll(function(err) {
        publishDevice();
    })
}

// Generate and set a unique hostname if default hostname is being used
if (os.hostname() == "atem-tally" || os.hostname() == "raspberrypi") {
    var shortid = getDevId().substring(0, 8);
    exec("sudo hostnamectl set-hostname atem-tally-" + shortid, (err, stdout, stderr) => {
        if (err) {
            console.error(`Error: ${err}`);
            return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
    });
    exec("sudo reboot", (err, stdout, stderr) => {
        if (err) {
            console.error(`Error: ${err}`);
            return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
    });
}


server.listen(3778);
publishDevice();

//do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));

leds.setAllPixels(255, 255, 255, 1.0);
leds.sendUpdate();

sessionio.on('connection', (socket) => {

    socket.on('pi_host_connect', function(msg) {

        if (TallySocket) {
            console.log("Already have an active connection");
            return;
        }

        var host = msg;

        TallySocket = new tallyio(host);

        TallySocket.on('connect', function() {
            console.log("Connected to server ");
            leds.clearAll();
            leds.sendUpdate();
        });

        TallySocket.on('update_tally', function(msg) {
            lastState = msg;
            updateTally();
        });

        TallySocket.on('call', function(msg) {
            leds.setAllPixels(255, 255, 255, 1.0);
            leds.sendUpdate();
            setTimeout(() => { updateTally(); }, 5000);
        });

        TallySocket.on('set_remote', function(msg) {
            if (msg.devId == getDevId() || msg.devId == '*') {
                if (msg.camera) {
                    config.camera = msg.camera;
                    localStorage.setItem('camera', msg.camera);
                    updateTally();
                    republishDevice();
                }

                if (msg.identify) {
                    leds.setAllPixels(0, 0, 255, 1.0);
                    leds.sendUpdate();
                    setTimeout(() => { updateTally(); }, 5000);
                }
            }
        });

        TallySocket.on('stop_tally', function(msg) {
            console.log(msg);
            Object.keys(ifaces).forEach(function(ifname) {

                ifaces[ifname].forEach(function(iface) {
                    if (iface.address == msg) {
                        TallySocket.disconnect();
                    }
                });
            });
        });

        TallySocket.on('disconnect', function() {
            console.log("Disconnected from server");
            leds.setAllPixels(255, 255, 255, 1.0);
            leds.sendUpdate();
            TallySocket = null;
        });
    });
});