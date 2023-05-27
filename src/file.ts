/*Performing plugin operations on markdown file contents*/

import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import { Notice, TFile } from 'obsidian'
import { Note, ExtendedInlineNote, InlineNote, RegexNote, CLOZE_ERROR, NOTE_TYPE_ERROR, TAG_SEP, ID_REGEXP_STR, TAG_REGEXP_STR } from './note'
import { Md5 } from 'ts-md5/dist/md5';
import * as AnkiConnect from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { CachedMetadata, HeadingCache } from 'obsidian'

const double_regexp: RegExp = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)(?:<!--)?ID: \d+)/g

function id_to_str(identifier: number, inline: boolean = false, comment: boolean = false): string {
    let result = ""
    result = "ID: " + identifier.toString()
    if (comment) {
        result = "<!--" + result + "-->"
    }
    if (inline) {
        result += " "
    } else {
        result += "\n"
    }
    return result
}

function string_insert(text: string, position_inserts: Array<[number, string]>): string {
    /*Insert strings in position_inserts into text, at indices.

    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")]*/
    let offset = 0
    let sorted_inserts: Array<[number, string]> = position_inserts.sort((a, b): number => a[0] - b[0])
    for (let insertion of sorted_inserts) {
        let position = insertion[0]
        let insert_str = insertion[1]
        text = text.slice(0, position + offset) + insert_str + text.slice(position + offset)
        offset += insert_str.length
    }
    return text
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
    /*Return a list of span-tuples for matches of pattern in text.*/
    let output: Array<[number, number]> = []
    let matches = text.matchAll(pattern)
    for (let match of matches) {
        output.push(
            [match.index, match.index + match[0].length]
        )
    }
    return output
}

function contained_in(span: [number, number], spans: Array<[number, number]>): boolean {
    /*Return whether span is contained in spans (+- 1 leeway)*/
    return spans.some(
        (element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1
    )
}

function* findignore(pattern: RegExp, text: string, ignore_spans: Array<[number, number]>): IterableIterator<RegExpMatchArray> {
    let matches = text.matchAll(pattern)
    for (let match of matches) {
        if (!(contained_in([match.index, match.index + match[0].length], ignore_spans))) {
            yield match
        }
    }
}

abstract class AbstractFile {
    file: string
    path: string
    url: string
    original_file: string
    data: FileData
    file_cache: CachedMetadata

    frozen_fields_dict: FROZEN_FIELDS_DICT
    target_deck: string
    global_tags: string

    notes_to_add: AnkiConnectNote[]
    id_indexes: number[]
    notes_to_edit: AnkiConnectNoteAndID[]
    notes_to_delete: number[]
    all_notes_to_add: AnkiConnectNote[]

    note_ids: Array<number | null>
    card_ids: number[]
    tags: string[]

    formatter: FormatConverter

    constructor(file_contents: string, path: string, url: string, data: FileData, file_cache: CachedMetadata) {
        this.data = data
        this.file = file_contents
        this.path = path
        this.url = url
        this.original_file = this.file
        this.file_cache = file_cache
        this.formatter = new FormatConverter(file_cache, this.data.vault_name)
    }

    setup_frozen_fields_dict() {
        let frozen_fields_dict: FROZEN_FIELDS_DICT = {}
        for (let note_type in this.data.fields_dict) {
            let fields: string[] = this.data.fields_dict[note_type]
            let temp_dict: Record<string, string> = {}
            for (let field of fields) {
                temp_dict[field] = ""
            }
            frozen_fields_dict[note_type] = temp_dict
        }
        for (let match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
            const [note_type, fields]: [string, string] = [match[1], match[2]]
            const virtual_note = note_type + "\n" + fields
            const parsed_fields: Record<string, string> = new Note(
                virtual_note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).getFields()
            frozen_fields_dict[note_type] = parsed_fields
        }
        this.frozen_fields_dict = frozen_fields_dict
    }

    setup_target_deck() {
        const result = this.file.match(this.data.DECK_REGEXP)
        this.target_deck = result ? result[1] : this.data.template["deckName"]
    }

    setup_global_tags() {
        const result = this.file.match(this.data.TAG_REGEXP)
        this.global_tags = result ? result[1] : ""
    }

    getHash(): string {
        return Md5.hashStr(this.file) as string
    }

    abstract scanFile(): void

    scanDeletions() {
        for (let match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
            this.notes_to_delete.push(parseInt(match[1]))
        }
    }

    getContextAtIndex(position: number): string {
        let result: string = this.path
        let currentContext: HeadingCache[] = []
        if (!(this.file_cache.hasOwnProperty('headings'))) {
            return result
        }
        for (let currentHeading of this.file_cache.headings) {
            if (position < currentHeading.position.start.offset) {
                //We've gone past position now with headings, so let's return!
                break
            }
            let insert_index: number = 0
            for (let contextHeading of currentContext) {
                if (currentHeading.level > contextHeading.level) {
                    insert_index += 1
                    continue
                }
                break
            }
            currentContext = currentContext.slice(0, insert_index)
            currentContext.push(currentHeading)
        }
        let heading_strs: string[] = []
        for (let contextHeading of currentContext) {
            heading_strs.push(contextHeading.heading)
        }
        let result_arr: string[] = [result]
        result_arr.push(...heading_strs)
        return result_arr.join(" > ")
    }

    abstract writeIDs(): void

    removeEmpties() {
        this.file = this.file.replace(this.data.EMPTY_REGEXP, "")
    }

    getAddNotes(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.addNote(note))
        }
        return AnkiConnect.multi(actions)
    }

    getDeleteNotes(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.deleteNotes(this.notes_to_delete)
    }

    getUpdateFields(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) { // notes_to_edit 은 하나의 note 에 여러 개의 anki 카드가 있어야 여러 개가 됨
            actions.push(
                AnkiConnect.updateNoteFields(
                    parsed.identifier, parsed.note.fields
                )
            )
        }
        return AnkiConnect.multi(actions)
    }

    getCardInfo(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {// notes_to_edit 은 하나의 note 에 여러 개의 anki 카드가 있어야 여러 개가 됨
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.cardsInfo(IDs)
    }

    getNoteInfo(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {// notes_to_edit 은 하나의 note 에 여러 개의 anki 카드가 있어야 여러 개가 됨
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.notesInfo(IDs)
    }

    getChangeDecks(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.changeDeck(this.card_ids, this.target_deck)
    }

    getClearTags(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {// notes_to_edit 은 하나의 note 에 여러 개의 anki 카드가 있어야 여러 개가 됨
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.removeTags(IDs, this.tags.join(" "))
    }

    getAddTags(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {// notes_to_edit 은 하나의 note 에 여러 개의 anki 카드가 있어야 여러 개가 됨
            actions.push(
                AnkiConnect.addTags([parsed.identifier], parsed.note.tags.join(" ") + " " + this.global_tags)
            )
        }
        return AnkiConnect.multi(actions)
    }

}

export class AllFile extends AbstractFile {
    ignore_spans: [number, number][]
    custom_regexps: Record<string, string>
    inline_notes_to_add: AnkiConnectNote[]
    inline_id_indexes: number[]
    regex_notes_to_add: AnkiConnectNote[]
    regex_id_indexes: number[]

    constructor(file_contents: string, path: string, url: string, data: FileData, file_cache: CachedMetadata) {
        super(file_contents, path, url, data, file_cache)
        this.custom_regexps = data.custom_regexps
    }

    add_spans_to_ignore() {
        this.ignore_spans = []
        this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
        const deck_result = this.file.match(this.data.DECK_REGEXP)
        if (deck_result) {
            this.ignore_spans.push([deck_result.index, deck_result.index + deck_result[0].length])
        }
        const tag_result = this.file.match(this.data.TAG_REGEXP)
        if (tag_result) {
            this.ignore_spans.push([tag_result.index, tag_result.index + tag_result[0].length])
        }
        this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
        this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_INLINE_MATH_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_DISPLAY_MATH_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_CODE_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_DISPLAY_CODE_REGEXP, this.file))
    }

    setupScan() {
        this.setup_frozen_fields_dict()
        this.setup_target_deck()
        this.setup_global_tags()
        this.add_spans_to_ignore()
        this.notes_to_add = []
        this.inline_notes_to_add = []
        this.regex_notes_to_add = []
        this.id_indexes = []
        this.inline_id_indexes = []
        this.regex_id_indexes = []
        this.notes_to_edit = []
        this.notes_to_delete = []
    }

    scanNotes() {
        for (let note_match of this.file.matchAll(this.data.NOTE_REGEXP)) {
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new Note(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.notes_to_add.push(parsed.note)
                this.id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                // Need to show an error otherwise
                else if (parsed.identifier == NOTE_TYPE_ERROR) {
                    console.warn("Did not recognise note type ", parsed.note.modelName, " in file ", this.path)
                } else {
                    console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                }
            } else {
                this.notes_to_edit.push(parsed)
            }
        }
    }

    scanInlineNotes() {
        for (let note_match of this.file.matchAll(this.data.INLINE_REGEXP)) {
            // position: note 에서 anki card 가 처음 시작하는 index + anki card 에서 ENDI 전까지 문자열의 시작 index + 그 문자열의 길이 (즉, anki card 에서 ENDI 바로 앞 position)
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            note = note.replaceAll(/(%%|\^[\w\d]{6})(?!\|)/g, "") // [[L3. (Root) GANs#^a18e8e|(참고)]] 와 같은 block reference 는 그대로 두고, ^3a3214 처럼 그냥 지저분한 주소만 제거하기 위한 정규식
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new ExtendedInlineNote(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.inline_notes_to_add.push(parsed.note)
                this.inline_id_indexes.push(position) // 어디에 ID: 123098123 를 넣을 것인지 이때 정함
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                // Need to show an error
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                new Notice(`Note with id ${parsed.identifier} does not exist in Anki!\n[FILE]\n${this.path}`, 50000)
                console.log(`Note with id ${parsed.identifier} does not exist in Anki!\n[FILE]\n${this.path}`)
            } else {
                this.notes_to_edit.push(parsed)
            }
        }
    }

    findOrSetAnkiCardID(str: string): number[] {
        let id = null
        let position = null
        this.file = this.file.replaceAll(/^---\n---\n/g, "") // 예외 처리
        this.file = this.file.replaceAll(/^---\nanki_id: \n---\n/g, "") // 예외 처리
        this.file = this.file.replaceAll(/^---\nanki_id: 0\n---\n/g, "") // 예외 처리
        this.file = this.file.replaceAll(/^anki_id: \n/gm, "") // 예외 처리
        //this.file = this.file.replaceAll(/^---\nanki_id: \d+?\n---\n/g, "") // TODO 이 라인 지워야 함
        //this.file = this.file.replaceAll(/^---\n[\s\S]*?\n---\n/g, "") // TODO 이 라인 지워야 함
        let matches = /^(---\n)([\s\S]*?\n)(---\n)/g.exec(this.file)
        if (matches !== null) {
            let ankiid_matches = /^anki_id: (\d+)\n/gm.exec(matches[0])
            if (ankiid_matches !== null) {
                id = Number(ankiid_matches[1])
            }
            else {
                this.file = this.file.replace(/^(---\n)([\s\S]*?\n)(---\n)/g, (whole, a, b, c) => {
                    return a + b + 'anki_id: \n' + c
                }
                )
                position = matches[1].length + matches[2].length + "anki_id: ".length
            }
        }
        else {
            this.file = "---\nanki_id: \n---\n" + this.file
            position = "---\nanki_id: ".length
        }
        return [id, -position] // 후에 -position 을 찾아 다른 양식으로 추가하기 위함(ID: 1238091 양식을 1238091 로 하기 위함)
    }
    max(a: number, b: number): number {
        return a > b ? a : b;
    }

    getAnkiCardIDS(): number[] {
        let IDS = []
        for (let matches of this.file.matchAll(/%%<br>STARTI[\s\S]*?ID: (\d+?) /g)) {
            let id = Number(matches[1])
            IDS.push(id)
        }
        let matches = /^--[\s\S]*?anki_id: (\d+)\n[\s\S]*?---\n/g.exec(this.file)
        if (matches !== null) {
            IDS.push(Number(matches[1]))
        }
        return IDS
    }

    preprocess_file_contents(str: string): string {
        str = str.replaceAll(/%%[\s\S]*?%%/g, "") // annotation 제거
        str = str.replaceAll(/<!--[\s\S]*?-->/g, "") // annotation 제거
        str = str.replaceAll(/^---\n[\s\S]*?\n---\n/g, "") // frontmatter 제거
        str = str.replaceAll(/\!\[\[/gm, "[[") // frontmatter 제거
        let ret = ""
        for (let line of str.split("\n")) {
            const m = /^(\s*)(.*)$/gm.exec(line)
            let [, indent, content] = m; //<ul> 을 통해 이미 특정 indent 에 속한 코드이기 때문에 첫줄에 해당하는 indent 는 없앤다
            //content = content.replace(/^(#+?.*?)/gm, "- **$1**") // header 를 bold 로 바꾼다
            content = content.replace(/^(#+?.*?)/gm, "</ul></ul></ul></ul></ul><br><br>$1") // header 를 bold 로 바꾼다
            if (indent.length >= 2) {
                ret += `${indent}.-`
            }
            else {
                ret += `\n${indent}${content}`
            }
        }
        str = ret
        str = `<font size="2">${str}</font>`
        return str
    }

    buildObsidianNoteToAnkiCard() {
        //let tfile = app.vault.getAbstractFileByPath(this.path) as TFile
        //console.log(this.file)
        let text = this.file
        if (this.path.includes("Reference")) {
            console.log("Reference")
        }
        let file_name = this.path.split("/").pop()
        let folder_path = this.path.split("/").slice(0, -1).join("/")
        let file_condition = /\(T\)|\(Cleaning\)|\(Meeting\)/g.exec(file_name) !== null
        let folder_condition = /Templ|0. Inbox|Welcome|hee-publish|Daily|Gantt|Attachment|supplement|References/gi.exec(folder_path) !== null

        if (file_condition || folder_condition) {
            this.file = this.file.replaceAll(/^---\n---\n/g, "")
            this.file = this.file.replaceAll(/^---\nanki_id: \d*?\n---\n/g, "")
            this.file = this.file.replaceAll(/^anki_id: \d*?\n/gm, "")
            return
        }
        text = this.preprocess_file_contents(text)
        text = `[Basic(MD)] **[Imagine the contents of this note]**<br> Back: ${text}.`
        let [id, position] = this.findOrSetAnkiCardID(this.file)
        let parsed = new ExtendedInlineNote(
            text,
            this.data.fields_dict,
            this.data.curly_cloze,
            this.data.highlights_to_cloze,
            this.formatter
        ).parse(
            this.target_deck,
            this.url,
            this.frozen_fields_dict,
            this.data,
            this.path
        )
        parsed.identifier = id
        console.log(id, parsed)
        parsed.note["fields"]["Front"] += `${parsed.note["fields"]["MDContext"]}`  // Front 를 DFS 경로 추가

        if (parsed.identifier == null) {
            this.inline_notes_to_add.push(parsed.note)
            this.inline_id_indexes.push(position) // 어디에 ID: 123098123 를 넣을 것인지 이때 정함
        } else if (!this.data.EXISTING_IDS.includes(id)) {
            new Notice(`OBnode to Anki with id ${parsed.identifier} does not exist in Anki!\n[FILE]\n${this.path}`, 50000)
            console.warn("OBnote to Anki with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
        } else {
            this.notes_to_edit.push(parsed)
        }
    }

    search(note_type: string, regexp_str: string) {
        //Search the file for regex matches
        //ignoring matches inside ignore_spans,
        //and adding any matches to ignore_spans.
        for (let search_id of [true, false]) {
            for (let search_tags of [true, false]) {
                let id_str = search_id ? ID_REGEXP_STR : ""
                let tag_str = search_tags ? TAG_REGEXP_STR : ""
                let regexp: RegExp = new RegExp(regexp_str + tag_str + id_str, 'gm')
                for (let match of findignore(regexp, this.file, this.ignore_spans)) {
                    this.ignore_spans.push([match.index, match.index + match[0].length])
                    const parsed: AnkiConnectNoteAndID = new RegexNote(
                        match, note_type, this.data.fields_dict,
                        search_tags, search_id, this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter
                    ).parse(
                        this.target_deck,
                        this.url,
                        this.frozen_fields_dict,
                        this.data,
                        this.data.add_context ? this.getContextAtIndex(match.index) : ""
                    )
                    if (search_id) {
                        if (!(this.data.EXISTING_IDS.includes(parsed.identifier))) {
                            if (parsed.identifier == CLOZE_ERROR) {
                                // This means it wasn't actually a note! So we should remove it from ignore_spans
                                this.ignore_spans.pop()
                                continue
                            }
                            console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                        } else {
                            this.notes_to_edit.push(parsed)
                        }
                    } else {
                        if (parsed.identifier == CLOZE_ERROR) {
                            // This means it wasn't actually a note! So we should remove it from ignore_spans
                            this.ignore_spans.pop()
                            continue
                        }
                        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                        this.regex_notes_to_add.push(parsed.note)
                        this.regex_id_indexes.push(match.index + match[0].length)
                    }
                }
            }
        }
    }

    scanFile() {
        this.setupScan()
        this.buildObsidianNoteToAnkiCard()
        this.scanNotes()
        this.scanInlineNotes()
        for (let note_type in this.custom_regexps) {
            const regexp_str: string = this.custom_regexps[note_type]
            if (regexp_str) {
                this.search(note_type, regexp_str)
            }
        }
        this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add).concat(this.regex_notes_to_add)
        this.scanDeletions()
    }

    fix_newline_ids() {
        this.file = this.file.replace(double_regexp, "$1")
    }

    writeIDs() {
        let normal_inserts: [number, string][] = []
        this.id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index]
                if (identifier) {
                    normal_inserts.push([id_position, id_to_str(identifier, false, this.data.comment)])
                }
            }
        )
        let inline_inserts: [number, string][] = []
        this.inline_id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index + this.notes_to_add.length] //Since regular then inline
                if (identifier) {
                    let idstr = ""
                    if (id_position < 0) {
                        idstr = identifier.toString()
                        id_position *= -1
                    }
                    else {
                        idstr = id_to_str(identifier, true, this.data.comment)
                    }
                    inline_inserts.push([id_position, idstr])
                }
            }
        )
        let regex_inserts: [number, string][] = []
        this.regex_id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index + this.notes_to_add.length + this.inline_notes_to_add.length] // Since regular then inline then regex
                if (identifier) {
                    regex_inserts.push([id_position, "\n" + id_to_str(identifier, false, this.data.comment)])
                }
            }
        )
        this.file = string_insert(this.file, normal_inserts.concat(inline_inserts).concat(regex_inserts))
        this.fix_newline_ids()
    }
}
