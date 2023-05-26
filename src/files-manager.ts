/*Class for managing a list of files, and their Anki requests.*/
import { ParsedSettings, FileData } from './interfaces/settings-interface'
import { App, TFile, TFolder, TAbstractFile, CachedMetadata, FileSystemAdapter, Notice } from 'obsidian'
import { AllFile } from './file'
import * as AnkiConnect from './anki'
import { basename } from 'path'

interface addNoteResponse {
    result: number,
    error: string | null
}

interface notesInfoResponse {
    result: Array<{
        noteId: number,
        modelName: string,
        tags: string[],
        fields: Record<string, {
            order: number,
            value: string
        }>,
        cards: number[]
    }>,
    error: string | null
}

interface Requests1Result {
    0: {
        error: string | null,
        result: Array<{
            result: addNoteResponse[],
            error: string | null
        }>
    },
    1: {
        error: string | null,
        result: notesInfoResponse[]
    },
    2: any,
    3: any,
    4: any

}

function difference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    let _difference = new Set(setA)
    for (let elem of setB) {
        _difference.delete(elem)
    }
    return _difference
}


export class FileManager {
    app: App
    data: ParsedSettings
    files: TFile[]
    ownFiles: Array<AllFile>
    entireobFiles: TFile[]
    entireFiles: Array<AllFile>
    file_hashes: Record<string, string>
    requests_1_result: any
    added_media_set: Set<string>

    constructor(app: App, data: ParsedSettings, files: TFile[], file_hashes: Record<string, string>, added_media: string[]) {
        this.app = app
        this.data = data
        this.files = files
        this.ownFiles = []
        this.entireFiles = []
        this.file_hashes = file_hashes
        this.added_media_set = new Set(added_media)
    }

    getUrl(file: TFile): string {
        return "obsidian://open?vault=" + encodeURIComponent(this.data.vault_name) + String.raw`&file=` + encodeURIComponent(file.path)
    }

    getFolderPathList(file: TFile): TFolder[] {
        let result: TFolder[] = []
        let abstractFile: TAbstractFile = file
        while (abstractFile && abstractFile.hasOwnProperty('parent')) {
            result.push(abstractFile.parent)
            abstractFile = abstractFile.parent
        }
        result.pop() // Removes top-level vault
        return result
    }

    getDefaultDeck(file: TFile, folder_path_list: TFolder[]): string {
        let folder_decks = this.data.folder_decks
        for (let folder of folder_path_list) {
            // Loops over them from innermost folder
            if (folder_decks[folder.path]) {
                return folder_decks[folder.path]
            }
        }
        // If no decks specified
        return this.data.template.deckName
    }

    getDefaultTags(file: TFile, folder_path_list: TFolder[]): string[] {
        let folder_tags = this.data.folder_tags
        let tags_list: string[] = []
        for (let folder of folder_path_list) {
            // Loops over them from innermost folder
            if (folder_tags[folder.path]) {
                tags_list.push(...folder_tags[folder.path].split(" "))
            }
        }
        tags_list.push(...this.data.template.tags)
        return tags_list
    }

    dataToFileData(file: TFile): FileData {
        const folder_path_list: TFolder[] = this.getFolderPathList(file)
        let result: FileData = JSON.parse(JSON.stringify(this.data))
        //Lost regexp, so have to get them back
        result.FROZEN_REGEXP = this.data.FROZEN_REGEXP
        result.DECK_REGEXP = this.data.DECK_REGEXP
        result.TAG_REGEXP = this.data.TAG_REGEXP
        result.NOTE_REGEXP = this.data.NOTE_REGEXP
        result.INLINE_REGEXP = this.data.INLINE_REGEXP
        result.EMPTY_REGEXP = this.data.EMPTY_REGEXP
        result.template.deckName = this.getDefaultDeck(file, folder_path_list)
        result.template.tags = this.getDefaultTags(file, folder_path_list)
        return result
    }

    async genAllFiles() {
        for (let file of this.files) {
            const content: string = await this.app.vault.read(file)
            const cache: CachedMetadata = this.app.metadataCache.getCache(file.path)
            const file_data = this.dataToFileData(file)
            this.ownFiles.push(
                new AllFile(
                    content,
                    file.path,
                    this.data.add_file_link ? this.getUrl(file) : "",
                    file_data,
                    cache
                )
            )
        }
    }

    async initialiseFiles(option: string) {
        await this.genAllFiles()
        this.entireFiles = this.ownFiles
        this.entireobFiles = this.files
        let files_changed: Array<AllFile> = []
        let obfiles_changed: TFile[] = []
        let existing_ids_in_vault = []
        for (let index in this.ownFiles) {
            const i = parseInt(index)
            let file = this.ownFiles[i]
            if (option !== "all_del")
                existing_ids_in_vault.push(...file.getAnkiCardIDS())

            file.scanFile()
            if (option.includes("all")) {
                console.log("Scan all the files")
                files_changed.push(file)
                obfiles_changed.push(this.files[i])
            }
            else {
                console.log("Scan only updated files")
                if (!(this.file_hashes.hasOwnProperty(file.path) && file.getHash() === this.file_hashes[file.path])) {
                    //Indicates it's changed or new
                    console.log("Scanning ", file.path, "as it's changed or new.")
                    files_changed.push(file)
                    obfiles_changed.push(this.files[i])
                }
            }
        }
        if (option !== "all_del")
            await this.delete_unused_ankicards(existing_ids_in_vault)
        this.ownFiles = files_changed
        this.files = obfiles_changed
    }

    async delete_unused_ankicards(existing_ids_in_vault: Number[]) {
        // remove existing ids from this.data.EXISTING_IDS_FromMD
        this.data.template["deckName"]
        this.data.EXISTING_IDS_TargetDeck = this.data.EXISTING_IDS_TargetDeck.filter(
            (id: Number) => !existing_ids_in_vault.includes(id)
        );
        //let request = AnkiConnect.multi([AnkiConnect.deleteNotes(this.data.EXISTING_IDS_TargetDeck)])
        if (this.data.EXISTING_IDS_TargetDeck.length > 0) {
            console.info(`Deleting unused Anki cards... ${this.data.EXISTING_IDS_TargetDeck}`)
            new Notice(`Deleting unused Anki cards... ${this.data.EXISTING_IDS_TargetDeck}`, 50000)
            let result = await AnkiConnect.invoke('deleteNotes', { notes: this.data.EXISTING_IDS_TargetDeck })
            console.log(result)
        }
    }


    async requests_hee() {
        let requests: AnkiConnect.AnkiConnectRequest[] = []
        let temp: AnkiConnect.AnkiConnectRequest[] = []
        console.info("Requesting note infos to get tags...")
        // add record property
        let ankicardid_to_fileindex = {}
        let index = 0
        for (let file of this.entireFiles) {
            let ankicardids = file.getNoteInfo()
            temp.push(ankicardids)
            for (const key in ankicardids['params']['notes']) {
                const ankicardid = ankicardids['params']['notes'][key]
                ankicardid_to_fileindex[ankicardid] = index
            }
            index += 1
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        let results = await AnkiConnect.invoke('multi', { actions: requests })
        this.parseNoteInfo_hee(results, ankicardid_to_fileindex)
        return results
    }

    async parseNoteInfo_hee(results: any, ankicardid_to_file: { [x: number]: number; }) {
        // for loop with key value pair
        for (let [key, ankicards_in_a_obsidian_note] of Object.entries(results[0]['result'])) { //[request 번호]['result'][note 번호]['result'][data 번호]['tags']
            let tags = []
            if (ankicards_in_a_obsidian_note['result'].length == 0) {
                continue
            }
            for (let [key, each_anki_card] of Object.entries(ankicards_in_a_obsidian_note['result'])) {
                let tags = each_anki_card['tags']

                // convert arrray to string
                let tags_string = tags.join(' ')
                if (tags_string.includes('remove')) {
                    // delete anki card
                    let ankicardid = each_anki_card['noteId']
                    let front = each_anki_card['fields']['Front'].value
                    console.log(`anki card with remove tags is found. front: ${front} id: ${ankicardid}`)
                    await this.deleteAnkiCard_in_obsidian(ankicardid, front, ankicardid_to_file[ankicardid])
                }
            }

        }
    }

    async deleteAnkiCard_in_obsidian(ankicardid: number, front: string, fileindex: number) {
        let contents = this.entireFiles[fileindex].file
        let INLINE_END_REGEX = new RegExp(String.raw`%%\s.*?ID: ${ankicardid}.*?` + this.data.INLINE_END_STRING + this.data.INLINE_TIME, "gm")
        for (let note_match of contents.matchAll(this.data.INLINE_START_END_TIME)) {
            //iterate each anki cards in a obsidian note
            if (note_match[0].match(INLINE_END_REGEX) != null) {

                // delete anki card from obsidian note
                let anki_start_contents = note_match[0].match(this.data.INLINE_START)
                this.entireFiles[fileindex].file = contents.replace(anki_start_contents[0], "").replace(INLINE_END_REGEX, "")

                if (this.entireFiles[fileindex].file == contents) {
                    console.log(`Deleting anki card from obsidian note is failed. ankicardid:${ankicardid}, obsidianNoteContens ${contents}`)
                    new Notice("Deleting anki card from obsidian note is failed. Check the log.")
                    throw new Error("Deleting anki card from obsidian note is failed")
                }

                this.app.vault.modify(this.entireobFiles[fileindex], this.entireFiles[fileindex].file)

                // delete anki card from anki
                let request = []
                request.push(AnkiConnect.multi([AnkiConnect.deleteNotes([ankicardid])]))
                let result = await AnkiConnect.invoke('multi', { actions: request })
                console.log(result)

                // The Records of Deleted Anki Cards
                try {
                    //create log file if not exist
                    let log_file = this.app.vault.getAbstractFileByPath('3. Private/The Records of Deleted Anki Cards.md') as TFile
                    if (log_file == null) {
                        await this.app.vault.create('./3. Private/The Records of Deleted Anki Cards.md', '')
                        log_file = this.app.vault.getAbstractFileByPath('3. Private/The Records of Deleted Anki Cards.md') as TFile
                    }
                    let log_file_contents = await this.app.vault.read(log_file)
                    let today = new Date();
                    let date = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
                    let time = today.getHours() + ":" + today.getMinutes() + ":" + today.getSeconds();
                    log_file_contents += `\n- ${date} ${time} (Anki card id: ${ankicardid}) in [${this.entireFiles[fileindex].path}](${this.entireFiles[fileindex].url})\n\`\`\`markdown\n${front}\n\`\`\``
                    await this.app.vault.modify(log_file, log_file_contents)
                    new Notice(`The records of deleted anki cards are updated. Check ./3. Private/The Records of Deleted Anki Cards.md`, 5000)
                } catch (error) {
                    new Notice(`Writing deleted anki cards into log file is failed. Check the error [${error}]`, 50000)
                }
            }
        }


    }

    async requests_1() {
        let requests: AnkiConnect.AnkiConnectRequest[] = []
        let temp: AnkiConnect.AnkiConnectRequest[] = []
        console.info("Requesting addition of notes into Anki...")
        for (let file of this.ownFiles) { // initialiseFiles 에서 hash 로 변경된 note (file)만 ownfiles 에 넣도록 하는 조건문 처리함. 여기서 Anki card 가 아닌 곳이 변경되어도 ownfiles 에 추가됨. 그래도 변경되지 않은 모든 note 를 temp 에 추가하는 비효율은 없음.
            temp.push(file.getAddNotes())
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        console.info("Requesting card IDs of notes to be edited...")
        for (let file of this.ownFiles) {
            temp.push(file.getNoteInfo())
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        console.info("Requesting tag list...")
        requests.push(AnkiConnect.getTags())
        console.info("Requesting update of fields of existing notes")
        for (let file of this.ownFiles) {
            temp.push(file.getUpdateFields())// 하나의 note(file) 에 포함된 notes_to_edit 을 추출하는 과정
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        console.info("Requesting deletion of notes..")
        for (let file of this.ownFiles) {
            temp.push(file.getDeleteNotes())
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        console.info("Requesting addition of media...")
        for (let file of this.ownFiles) {
            const mediaLinks = difference(file.formatter.detectedMedia, this.added_media_set)
            for (let mediaLink of mediaLinks) {
                console.log("Adding media file: ", mediaLink)
                const dataFile = this.app.metadataCache.getFirstLinkpathDest(mediaLink, file.path)
                if (!(dataFile)) {
                    console.warn("Couldn't locate media file ", mediaLink)
                }
                else {
                    // Located successfully, so treat as if we've added the media
                    this.added_media_set.add(mediaLink)
                    const realPath = (this.app.vault.adapter as FileSystemAdapter).getFullPath(dataFile.path)
                    temp.push(
                        AnkiConnect.storeMediaFileByPath(
                            basename(mediaLink),
                            realPath
                        )
                    )
                }
            }
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        this.requests_1_result = await AnkiConnect.invoke('multi', { actions: requests })
        await this.parse_requests_1()
    }

    async parse_requests_1() {
        const response = this.requests_1_result as Requests1Result
        if (response[5].result.length >= 1 && response[5].result[0].error != null) {
            new Notice("Please update AnkiConnect! The way the script has added media files has changed.")
            console.warn("Please update AnkiConnect! The way the script has added media files has changed.")
        }
        let note_ids_array_by_file: Requests1Result[0]["result"]
        try {
            note_ids_array_by_file = AnkiConnect.parse(response[0])
        } catch (error) {
            console.error("Error: ", error)
            note_ids_array_by_file = response[0].result
        }
        const note_info_array_by_file = AnkiConnect.parse(response[1])
        const tag_list: string[] = AnkiConnect.parse(response[2])
        for (let index in note_ids_array_by_file) {
            let i: number = parseInt(index)
            let file = this.ownFiles[i]
            let file_response: addNoteResponse[]
            try {
                file_response = AnkiConnect.parse(note_ids_array_by_file[i])
            } catch (error) {
                console.error("Error: ", error)
                file_response = note_ids_array_by_file[i].result
            }
            file.note_ids = []
            for (let index in file_response) {
                let i = parseInt(index)
                let response = file_response[i]
                try {
                    file.note_ids.push(AnkiConnect.parse(response))
                } catch (error) {
                    console.warn("Failed to add note ", file.all_notes_to_add[i], " in file", file.path, " due to error ", error)
                    new Notice(`Failed to add note ${file.all_notes_to_add[i]} in file ${file.path} due to error [${error}]`, 50000)
                    file.note_ids.push(response.result)
                }
            }
        }
        for (let index in note_info_array_by_file) {
            let i: number = parseInt(index)
            let file = this.ownFiles[i]
            const file_response = AnkiConnect.parse(note_info_array_by_file[i])
            let temp: number[] = []
            for (let note_response of file_response) {
                temp.push(...note_response.cards)
            }
            file.card_ids = temp
        }
        for (let index in this.ownFiles) {
            let i: number = parseInt(index)
            let ownFile = this.ownFiles[i]
            let obFile = this.files[i]
            ownFile.tags = tag_list
            ownFile.writeIDs()
            ownFile.removeEmpties()
            if (ownFile.file !== ownFile.original_file) {
                await this.app.vault.modify(obFile, ownFile.file)
            }
        }
        await this.requests_2()
    }

    getHashes(): Record<string, string> {
        let result: Record<string, string> = {}
        for (let file of this.ownFiles) {
            result[file.path] = file.getHash()
        }
        return result
    }

    async requests_2(): Promise<void> {
        let requests: AnkiConnect.AnkiConnectRequest[] = []
        let temp: AnkiConnect.AnkiConnectRequest[] = []
        console.info("Requesting cards to be moved to target deck...")
        for (let file of this.ownFiles) {
            temp.push(file.getChangeDecks())
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        console.info("Requesting tags to be replaced...")
        for (let file of this.ownFiles) {
            temp.push(file.getClearTags())
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        for (let file of this.ownFiles) {
            temp.push(file.getAddTags())
        }
        requests.push(AnkiConnect.multi(temp))
        temp = []
        await AnkiConnect.invoke('multi', { actions: requests })
        console.info("All done!")
    }



}
