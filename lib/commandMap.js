module.exports = class CommandMap {
    constructor(adapter) {
        this.adapter = adapter;
        this.commandMap = [
            {command: 'wake_up'},
            {command: 'flash_lights'},
            {command: 'charge_port_door_open'},
            {command: 'charge_port_door_close'},
            {command: 'charge_start'},
            {command: 'charge_stop'},
            {command: 'door_lock'},
            {command: 'door_unlock'},
            {command: 'auto_conditioning_start'},
            {command: 'auto_conditioning_stop'}
        ];
    }

    getCommandMap() {
        return this.commandMap;
    }
};

