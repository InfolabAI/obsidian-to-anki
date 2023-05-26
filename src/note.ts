/*Manages parsing notes into a dictionary formatted for AnkiConnect.

Input must be the note text.
Does NOT deal with finding the note in the file.*/

import { FormatConverter } from './format'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FIELDS_DICT, FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { FileData } from './interfaces/settings-interface'
import { LongestPath } from './find-context'

const TAG_PREFIX: string = "Tags: "
export const TAG_SEP: string = " "
export const ID_REGEXP_STR: string = String.raw`\n?(?:<!--)?(?:ID: (\d+).*)`
export const TAG_REGEXP_STR: string = String.raw`(Tags: .*)`
const OBS_TAG_REGEXP: RegExp = /#(\w+)/g

const ANKI_CLOZE_REGEXP: RegExp = /{{c\d+::[\s\S]+?}}/
export const CLOZE_ERROR: number = 42
export const NOTE_TYPE_ERROR: number = 69

function has_clozes(text: string): boolean {
    /*Checks whether text actually has cloze deletions.*/
    return ANKI_CLOZE_REGEXP.test(text)
}

function note_has_clozes(note: AnkiConnectNote): boolean {
    /*Checks whether a note has cloze deletions in any of its fields.*/
    for (let i in note.fields) {
        if (has_clozes(note.fields[i])) {
            return true
        }
    }
    return false
}

abstract class AbstractNote {
    text: string
    split_text: string[]
    current_field_num: number
    delete: boolean
    identifier: number | null
    tags: string[]
    note_type: string
    field_names: string[]
    current_field: string
    ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/
    formatter: FormatConverter
    curly_cloze: boolean
    highlights_to_cloze: boolean
    no_note_type: boolean
    longest_path: LongestPath

    constructor(note_text: string, fields_dict: FIELDS_DICT, curly_cloze: boolean, highlights_to_cloze: boolean, formatter: FormatConverter) {
        app.metadataCache.resolvedLinks
        this.text = note_text.trim()
        this.current_field_num = 0
        this.delete = false
        this.no_note_type = false
        this.split_text = this.getSplitText()
        this.identifier = this.getIdentifier()
        this.tags = this.getTags()
        this.note_type = this.getNoteType()
        if (!(fields_dict.hasOwnProperty(this.note_type))) {
            this.no_note_type = true
            return
        }
        this.field_names = fields_dict[this.note_type]
        this.current_field = this.field_names[0]
        this.formatter = formatter
        this.curly_cloze = curly_cloze
        this.highlights_to_cloze = highlights_to_cloze
    }

    abstract getSplitText(): string[]

    abstract getIdentifier(): number | null

    abstract getTags(): string[]

    abstract getNoteType(): string

    abstract getFields(): Record<string, string>

    parse(deck: string, url: string, frozen_fields_dict: FROZEN_FIELDS_DICT, data: FileData, context: string): AnkiConnectNoteAndID {
        let template = JSON.parse(JSON.stringify(data.template))
        template["modelName"] = this.note_type
        if (this.no_note_type) {
            return { note: template, identifier: NOTE_TYPE_ERROR }
        }
        template["fields"] = this.getFields()
        const file_link_fields = data.file_link_fields
        if (url) {
            let folder_path = context.split("/")
            folder_path.pop()
            let note_url_format = this.formatter.ret_url_format(context.split(" > ")[0].split("/").pop().replaceAll(".md", ""), url)
            template["fields"][file_link_fields[this.note_type]] += note_url_format + ` (${folder_path.join("/")})`
        }
        if (Object.keys(frozen_fields_dict).length) {
            this.formatter.format_note_with_frozen_fields(template, frozen_fields_dict)
        }
        if (context) {
            this.longest_path = new LongestPath(app.metadataCache.resolvedBackLinks)
            let longest_context = this.longest_path.dfs(context.split(" > ")[0])
            const context_field = data.context_fields[this.note_type]
            template["fields"][context_field] += longest_context
        }
        /*
        if (data.add_obs_tags) {
            for (let key in template["fields"]) {
                for (let match of template["fields"][key].matchAll(OBS_TAG_REGEXP)) {
                    this.tags.push(match[1])
                }
                template["fields"][key] = template["fields"][key].replace(OBS_TAG_REGEXP, "")
            }
        }
        template["tags"].push(...this.tags)*/
        template["deckName"] = deck
        return { note: template, identifier: this.identifier }
    }

}

export class Note extends AbstractNote {

    getSplitText(): string[] {
        return this.text.split("\n")
    }

    getIdentifier(): number | null {
        if (this.ID_REGEXP.test(this.split_text[this.split_text.length - 1])) {
            return parseInt(this.ID_REGEXP.exec(this.split_text.pop())[1])
        } else {
            return null
        }
    }

    getTags(): string[] {
        if (this.split_text[this.split_text.length - 1].startsWith(TAG_PREFIX)) {
            return this.split_text.pop().slice(TAG_PREFIX.length).split(TAG_SEP)
        } else {
            return []
        }
    }

    getNoteType(): string {
        return this.split_text[0]
    }

    fieldFromLine(line: string): [string, string] {
        /*From a given line, determine the next field to add text into.

        Then, return the stripped line, and the field.*/
        for (let field of this.field_names) {
            if (line.startsWith(field + ":")) {
                return [line.slice((field + ":").length), field]
            }
        }
        return [line, this.current_field]
    }

    getFields(): Record<string, string> {
        let fields: Record<string, string> = {}
        for (let field of this.field_names) {
            fields[field] = ""
        }
        for (let line of this.split_text.slice(1)) {
            [line, this.current_field] = this.fieldFromLine(line)
            fields[this.current_field] += line + "\n"
        }
        for (let key in fields) {
            fields[key] = this.formatter.format(
                fields[key].trim(),
                this.note_type.includes("Cloze") && this.curly_cloze,
                this.highlights_to_cloze
            ).trim()
        }
        return fields
    }

}

export class ExtendedInlineNote extends AbstractNote {

    static TAG_REGEXP: RegExp = /Tags: (.*)/;
    static ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/;
    static TYPE_REGEXP: RegExp = /\[(.*?)\]/;

    getSplitText(): string[] {
        return this.text.split(" ")
    }

    getIdentifier(): number | null {
        const result = this.text.match(ExtendedInlineNote.ID_REGEXP)
        if (result) {
            this.text = this.text.slice(0, result.index).trim()
            return parseInt(result[1])
        } else {
            return null
        }
    }

    getTags(): string[] {
        const result = this.text.match(ExtendedInlineNote.TAG_REGEXP)
        if (result) {
            this.text = this.text.slice(0, result.index).trim()
            return result[1].split(TAG_SEP)
        } else {
            return []
        }
    }

    getNoteType(): string {
        const result = this.text.match(ExtendedInlineNote.TYPE_REGEXP)
        this.text = this.text.slice(result.index + result[0].length)
        return result[1]
    }

    fieldFromLine(line: string): [string, string] {
        /*From a given line, determine the next field to add text into.

        Then, return the stripped line, and the field.*/
        for (let field of this.field_names) {
            if (line.startsWith(field + ":")) {
                return [line.slice((field + ":").length), field]
            }
        }
        return [line, this.current_field]
    }

    removeCommonIndent(text: string): string {
        const lines = text.split('\n').filter(line => line.trim() !== '');

        if (lines.length === 0) {
            return '';
        }

        const firstLineIndent = lines[0].search(/\S/);
        let commonIndent = firstLineIndent;

        for (let i = 1; i < lines.length; i++) {
            const lineIndent = lines[i].search(/\S/);
            commonIndent = Math.min(commonIndent, lineIndent);
        }

        const trimmedLines = lines.map(line => line.slice(commonIndent));
        return trimmedLines.join('\n');
    }


    getFields(): Record<string, string> {
        let fields: Record<string, string> = {}
        for (let field of this.field_names) {
            fields[field] = ""
        }
        for (let word of this.text.split(" ")) {
            for (let field of this.field_names) {
                if (word === field + ":") {
                    this.current_field = field
                    word = ""
                }
            }
            fields[this.current_field] += word + " "
        }
        for (let key in fields) {
            fields[key] = this.formatter.format(
                this.removeCommonIndent(fields[key]),
                false, false
            ).trim()
        }
        return fields
    }


}

export class InlineNote extends AbstractNote {

    static TAG_REGEXP: RegExp = /Tags: (.*)/;
    static ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/;
    static TYPE_REGEXP: RegExp = /\[(.*?)\]/;

    getSplitText(): string[] {
        return this.text.split(" ")
    }

    getIdentifier(): number | null {
        const result = this.text.match(InlineNote.ID_REGEXP)
        if (result) {
            this.text = this.text.slice(0, result.index).trim()
            return parseInt(result[1])
        } else {
            return null
        }
    }

    getTags(): string[] {
        const result = this.text.match(InlineNote.TAG_REGEXP)
        if (result) {
            this.text = this.text.slice(0, result.index).trim()
            return result[1].split(TAG_SEP)
        } else {
            return []
        }
    }

    getNoteType(): string {
        const result = this.text.match(InlineNote.TYPE_REGEXP)
        this.text = this.text.slice(result.index + result[0].length)
        return result[1]
    }

    getFields(): Record<string, string> {
        let fields: Record<string, string> = {}
        for (let field of this.field_names) {
            fields[field] = ""
        }
        for (let word of this.text.split(" ")) {
            for (let field of this.field_names) {
                if (word === field + ":") {
                    this.current_field = field
                    word = ""
                }
            }
            fields[this.current_field] += word + " "
        }
        for (let key in fields) {
            fields[key] = this.formatter.format(
                fields[key].trim(),
                this.note_type.includes("Cloze") && this.curly_cloze,
                this.highlights_to_cloze
            ).trim()
        }
        return fields
    }


}

export class RegexNote {

    match: RegExpMatchArray
    note_type: string
    groups: Array<string>
    identifier: number | null
    tags: string[]
    field_names: string[]
    curly_cloze: boolean
    highlights_to_cloze: boolean
    formatter: FormatConverter

    constructor(
        match: RegExpMatchArray,
        note_type: string,
        fields_dict: FIELDS_DICT,
        tags: boolean,
        id: boolean,
        curly_cloze: boolean,
        highlights_to_cloze: boolean,
        formatter: FormatConverter
    ) {
        this.match = match
        this.note_type = note_type
        this.identifier = id ? parseInt(this.match.pop()) : null
        this.tags = tags ? this.match.pop().slice(TAG_PREFIX.length).split(TAG_SEP) : []
        this.field_names = fields_dict[note_type]
        this.curly_cloze = curly_cloze
        this.formatter = formatter
        this.highlights_to_cloze = highlights_to_cloze
    }

    getFields(): Record<string, string> {
        let fields: Record<string, string> = {}
        for (let field of this.field_names) {
            fields[field] = ""
        }
        for (let index in this.match.slice(1)) {
            fields[this.field_names[index]] = this.match.slice(1)[index] ? this.match.slice(1)[index] : ""
        }
        for (let key in fields) {
            fields[key] = this.formatter.format(
                fields[key].trim(),
                this.note_type.includes("Cloze") && this.curly_cloze,
                this.highlights_to_cloze
            ).trim()
        }
        return fields
    }

    parse(deck: string, url: string = "", frozen_fields_dict: FROZEN_FIELDS_DICT, data: FileData, context: string): AnkiConnectNoteAndID {
        let template = JSON.parse(JSON.stringify(data.template))
        template["modelName"] = this.note_type
        template["fields"] = this.getFields()
        const file_link_fields = data.file_link_fields
        if (url) {
            this.formatter.format_note_with_url(template, url, file_link_fields[this.note_type])
        }
        if (Object.keys(frozen_fields_dict).length) {
            this.formatter.format_note_with_frozen_fields(template, frozen_fields_dict)
        }
        if (context) {
            const context_field = data.context_fields[this.note_type]
            template["fields"][context_field] += context
        }
        if (this.note_type.includes("Cloze") && !(note_has_clozes(template))) {
            this.identifier = CLOZE_ERROR //An error code that says "don't add this note!"
        }
        template["tags"].push(...this.tags)
        template["deckName"] = deck
        return { note: template, identifier: this.identifier }
    }
}
