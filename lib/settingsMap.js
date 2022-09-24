module.exports = class SettingsMap {
    constructor(adapter) {
        this.adapter = adapter;
        this.settingsMap = [
            {setting: 'charge_limit', type: 'number', param: 'percent'},
            {setting: 'charging_amps', type: 'number', param: 'charging_amps'}
        ];
    }

    getSettingsMap() {
        return this.settingsMap;
    }

    getSetting(name) {
        for (let i=0; i<this.settingsMap.length; i++) {
            if ( this.settingsMap[i].setting == name ) {
                return this.settingsMap[i];
            }
        }

        return null;
    }
};

