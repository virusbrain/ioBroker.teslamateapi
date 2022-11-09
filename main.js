'use strict';

/*
 * Created with @iobroker/create-adapter v2.2.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const https = require('https');
const SettingsMap = require('./lib/settingsMap');
const CommandMap = require('./lib/commandMap');

// Load your modules here, e.g.:
// const fs = require("fs");

class Teslamateapi extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'teslamateapi',
        });

        this.teslamateApiClient = null;
        this.requestTimeout = 3000;

        this.connectionTestInterval = null;
        this.refreshStatusInterval = null;

        this.objectsCreated = [];

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {

        this.log.info(`Headers: ${JSON.stringify(this.config.headers)}`);

        if (!this.config.serverUrl) {
            this.log.error(`Server URL is empty. Please specify one in the adapter settings!`);
            return;
        }

        if (!this.config.access_token) {
            this.log.error(`Access token is empty. Please specify one in the adapter settings!`);
            return;
        }

        if ( this.config.refresh_interval * 1000 < this.requestTimeout ) {
            this.log.warn(`Your configured refresh interval is lower than three seconds. The refresh interval will be set to three seconds!`);
            this.config.refresh_interval = this.requestTimeout / 1000;
        }

        const requestHeaders = {};
        if ( this.config.headers.length > 0 ) {
            this.config.headers.forEach((header) => {
                const key = header.split('=')[0];
                const value = header.split('=')[1];
                requestHeaders[key] = value;
            });
        }
        this.log.debug(`Current requestHeaders: ${JSON.stringify(requestHeaders)}`);

        this.log.debug(`Current serverUrl is ${this.config.serverUrl}`);

        requestHeaders[`Authorization`] = 'Bearer ' + this.config.access_token;
        this.teslamateApiClient = axios.create({
            baseURL: `${this.config.serverUrl}`,
            timeout: this.requestTimeout,
            responseType: 'json',
            responseEncoding: 'utf8',
            headers: requestHeaders,
            httpsAgent: new https.Agent(
                {
                    rejectUnauthorized: false
                }
            )
        });

        this.testConnection();
        this.refreshStatus();

        await this.getCarsAndPopulateObjects().catch(e => { this.log.error(e); });

        this.subscribeStates('*');

        this.connectionTestInterval = this.setInterval(async () => {
            await this.testConnection();
        }, 60000);

        this.refreshStatusInterval = this.setInterval(async () => {
            await this.refreshStatus();
        }, this.config.refresh_interval * 1000);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState('info.connection', false, true);

            this.clearInterval(this.connectionTestInterval);
            this.clearInterval(this.refreshStatusInterval);

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if ( state && state.ack == false ) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            // Check if the changed state is a command
            if (id.includes('.commands.')) {
                // a command was executed.
                const vin = id.split('.')[3];
                const command = id.split('.')[5];

                this.sendCommand(vin, command);
            } else if ( id.includes('.settings.') ) {
                // teslamateapi.0.cars.5YJ3E7EAXKF372359.settings.charge_limit
                const settings = new SettingsMap(this);
                const vin = id.split('.')[3];
                const setting = settings.getSetting(id.split('.')[5]);
                const command = 'set_' + setting.setting;
                this.log.info(`The following Setting was found: ${JSON.stringify(setting)}`);

                const data = {};
                data[setting.param] = state.val;

                this.sendCommand(vin, command, data);

                // Acknowlege the state
                this.setStateAsync(id, state.val, true);
            }

        }
    }

    async sendCommand(vin, command, data = null) {
        try {
            const carId = await this.getStateAsync('cars.' + vin + '.info.car_id');

            let wakeUpTimeout = 0;
            let carState = await this.getStateAsync('cars.' + vin + '.status.state');
            if ( command != 'wake_up' &&
                 this.config.force_command_execution == true &&
                 carState && carState.val == 'suspended') {
                // Send the wake up command
                await this.sendCommand(vin, 'wake_up');

                // and wait until car woke up:
                while ( (carState && carState.val != 'online') && wakeUpTimeout <= 40000) {
                    this.log.debug('Car is not awake yet. Wait two more seconds. (' + wakeUpTimeout + ' - ' + carState.val + ')' );

                    // On the first try, also resume the logging of Teslamate to get updated state.
                    if ( wakeUpTimeout == 0 ) {
                        this.log.debug('Resuming Teslamate logging...');
                        await this.resumeTeslamateLogging(carId.val);
                    }

                    wakeUpTimeout += 2000;
                    await this.delay(2000);
                    await this.refreshStatus();
                    carState = await this.getStateAsync('cars.' + vin + '.status.state');
                }

                this.log.debug('Car woke up.');
            }

            this.log.debug('Sending command: ' + command);
            if (carId) {
                let response;
                if ( data == null ) {
                    response = await this.teslamateApiClient.post('/v1/cars/' + carId.val + '/command/' + command);
                } else {
                    response = await this.teslamateApiClient.post('/v1/cars/' + carId.val + '/command/' + command, data);
                }
                this.log.debug(`sendCommand(${command}) ${JSON.stringify(response.status)}: ${JSON.stringify(response.data)}`);
            } else {
                this.log.error('Could not determine the CarID for VIN: ' + vin);
            }
        } catch (err) {
            this.log.error(err);
            this.setState('info.connection', false, true);
        }
    }

    async resumeTeslamateLogging(carId) {
        try {
            await this.teslamateApiClient.put('/v1/cars/' + carId + '/logging/resume');
        } catch (error) {
            this.log.error(error);
            this.setState('info.connection', false, true);
        }
    }

    async refreshStatus() {
        try {
            const response = await this.teslamateApiClient.get('/v1/cars');
            this.log.debug('Refreshing status');
            const cars = response.data.data.cars;
            // this.log.debug(`refreshStatus() cars: ${JSON.stringify(cars)}`);

            for(const car of cars) {
                const response = await this.teslamateApiClient.get('/v1/cars/' + car.car_id + '/status');
                const statuses = response.data.data.status;
                // console.log(statuses);
                // this.log.debug(`refreshStatus()2 statuses: ${JSON.stringify(statuses)}`);

                for (const key in statuses) {
                    //console.log(key, statuses[key]);
                    if ( statuses[key] != null && typeof statuses[key] !== 'object' ) {
                        const objectId = 'cars.' + car.car_details.vin + '.status.' + key;
                        if ( !this.objectsCreated.includes(objectId) ) {
                            await this.setObjectNotExistsAsync(objectId, {
                                type: 'state',
                                common: {
                                    name: key,
                                    type: typeof statuses[key],
                                    role: '',
                                    write: false,
                                    read: true
                                },
                                native: {}
                            });
                            this.objectsCreated.push(objectId);
                        }
                        this.setStateAsync(objectId, statuses[key], true);
                    } else {
                        for ( const subKey in statuses[key] ) {
                            const objectId = 'cars.' + car.car_details.vin + '.status.' + key + '.' + subKey;
                            if ( !this.objectsCreated.includes(objectId) ) {
                                await this.setObjectNotExistsAsync(objectId, {
                                    type: 'state',
                                    common: {
                                        name: subKey,
                                        type: typeof statuses[key][subKey],
                                        role: '',
                                        write: false,
                                        read: true
                                    },
                                    native: {}
                                });
                                this.objectsCreated.push(objectId);
                            }
                            this.setStateAsync(objectId, statuses[key][subKey], true);
                        }
                    }
                }
            }
        } catch (error) {
            this.log.error(error);
            this.setState('info.connection', false, true);
        }
    }

    async getCarsAndPopulateObjects() {
        try {
            const response = await this.teslamateApiClient.get('/v1/cars');

            // this.log.debug(`getCars() ${JSON.stringify(response.status)}: ${JSON.stringify(response.data)}`);
            const cars = response.data.data.cars;
            // this.log.debug(`getCars() cars: ${JSON.stringify(cars)}`);

            let commands = new CommandMap(this);
            commands = commands.getCommandMap();
            // this.log.debug(`commands: ${JSON.stringify(commands)}`);

            let settings = new SettingsMap(this);
            settings = settings.getSettingsMap();

            for ( const car of cars) {
                const objectId = 'cars.' + car.car_details.vin + '.info.car_id';
                if ( !this.objectsCreated.includes(objectId) ) {
                    await this.setObjectNotExistsAsync(objectId, {
                        type: 'state',
                        common: {
                            name: 'car_id',
                            type: typeof car.car_id,
                            role: '',
                            write: false,
                            read: true
                        },
                        native: {}
                    });
                    this.objectsCreated.push(objectId);
                }
                this.setStateAsync(objectId, car.car_id, true);

                for (const [prop, val] of Object.entries(car.car_details)) {
                    const objectId = 'cars.' + car.car_details.vin + '.info.' + prop;
                    if ( !this.objectsCreated.includes(objectId) ) {
                        await this.setObjectNotExistsAsync(objectId, {
                            type: 'state',
                            common: {
                                name: prop,
                                type: typeof val,
                                role: '',
                                write: false,
                                read: true
                            },
                            native: {}
                        });
                        this.objectsCreated.push(objectId);
                    }
                    this.setStateAsync(objectId, val, true);
                }

                // Populate commands:
                commands.forEach(async(command) => {
                    const objectId = 'cars.' + car.car_details.vin + '.commands.' + command.command;
                    if ( !this.objectsCreated.includes(objectId) ) {
                        await this.setObjectNotExistsAsync(objectId, {
                            type: 'state',
                            common: {
                                name: command.name || '',
                                type: command.type || 'boolean',
                                role: command.role || 'button',
                                write: true,
                                read: true,
                            },
                            native: {},
                        }).catch(e => {this.log.error(e);});
                    }
                });

                // Populate settings:
                settings.forEach(async(setting) => {
                    const objectId = 'cars.' + car.car_details.vin + '.settings.' + setting.setting;
                    if ( !this.objectsCreated.includes(objectId) ) {
                        await this.setObjectNotExistsAsync(objectId, {
                            type: 'state',
                            common: {
                                name: setting.setting || '',
                                type: setting.type || 'string',
                                role: 'value',
                                write: true,
                                read: true,
                            },
                            native: {},
                        }).catch(e => {this.log.error(e);});
                    }
                });
            }
        } catch (err) {
            this.log.error(err);
            this.setState('info.connection', false, true);
        }
    }

    async testConnection() {
        this.log.debug('testing connection!');
        try {
            const response = await this.teslamateApiClient.get('/ping');
            this.log.debug(`testConnection ${JSON.stringify(response.status)}: ${JSON.stringify(response.data)}`);

            if (response.data.message == 'pong') {
                this.setState('info.connection', true, true);
            }
        } catch (err) {
            this.log.error(err);
            this.setState('info.connection', false, true);
        }
    }

}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Teslamateapi(options);
} else {
    // otherwise start the instance directly
    new Teslamateapi();
}
