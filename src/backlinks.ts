export class Backlinks {
    public getBackLinks_hcustom() {
        var resolvedBackLinks: Record<string, any> = {}
        //initialize
        for (let [key, value] of Object.entries(app.metadataCache.resolvedLinks)) {
            resolvedBackLinks[key] = {}
        }
        app.metadataCache['resolvedBackLinks'] = resolvedBackLinks

        for (let [key, value] of Object.entries(app.metadataCache.resolvedLinks)) {
            //new Notice(key)
            for (let [outlink, v] of Object.entries(value)) {
                app.metadataCache['resolvedBackLinks'][outlink][key] = 1
            }
        }
    }
}