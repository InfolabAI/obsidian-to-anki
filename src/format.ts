import { AnkiConnectNote } from './interfaces/note-interface'
import { basename, extname } from 'path'
import { Converter } from 'showdown'
import { CachedMetadata } from 'obsidian'
import * as c from './constants'

import showdownHighlight from 'showdown-highlight'

const ANKI_MATH_REGEXP: RegExp = /(\\\[[\s\S]*?\\\])|(\\\([\s\S]*?\\\))/g
const HIGHLIGHT_REGEXP: RegExp = /==(.*?)==/g

const MATH_REPLACE: string = "OBSTOANKIMATH"
const INLINE_CODE_REPLACE: string = "OBSTOANKICODEINLINE"
const DISPLAY_CODE_REPLACE: string = "OBSTOANKICODEDISPLAY"

const CLOZE_REGEXP: RegExp = /(?:(?<!{){(?:c?(\d+)[:|])?(?!{))((?:[^\n][\n]?)+?)(?:(?<!})}(?!}))/g

const IMAGE_EXTS: string[] = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".tiff"]
const AUDIO_EXTS: string[] = [".wav", ".m4a", ".flac", ".mp3", ".wma", ".aac", ".webm"]

const PARA_OPEN: string = "<p>"
const PARA_CLOSE: string = "</p>"

let cloze_unset_num: number = 1

let converter: Converter = new Converter({
    simplifiedAutoLink: true,
    literalMidWordUnderscores: true,
    tables: true, tasklists: true,
    simpleLineBreaks: true,
    requireSpaceBeforeHeadingText: true,
    extensions: [showdownHighlight]
})

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export class FormatConverter {

    file_cache: CachedMetadata
    vault_name: string
    detectedMedia: Set<string>

    constructor(file_cache: CachedMetadata, vault_name: string) {
        this.vault_name = vault_name
        this.file_cache = file_cache
        this.detectedMedia = new Set()
    }

    getUrlFromLink(link: string): string {
        return "obsidian://open?vault=" + encodeURIComponent(this.vault_name) + String.raw`&file=` + encodeURIComponent(link)
    }

    ret_url_format(obsidian_note_title: string, url: string): string {
        return `<a href="${url}" class="obsidian-link">${obsidian_note_title}</a>`
    }

    format_note_with_url(note: AnkiConnectNote, url: string, field: string): void {
        note.fields[field] += '<br><a href="' + url + '" class="obsidian-link">Obsidian</a>'
    }

    format_note_with_frozen_fields(note: AnkiConnectNote, frozen_fields_dict: Record<string, Record<string, string>>): void {
        for (let field in note.fields) {
            note.fields[field] += frozen_fields_dict[note.modelName][field]
        }
    }

    obsidian_to_anki_math(note_text: string): string {
        note_text = note_text.replace(
            c.OBS_DISPLAY_MATH_REGEXP, "\\[$1\\]"
        )

        //inline math 와 code block 내부의 typescript ${} ${} 는 서로 구분할 수 없으므로, code block 이 아닐때만 적용해준다.
        const lines = note_text.split("\n");
        let result = ""
        let is_in_code_block = false
        for (let line of lines) {
            if (line.match(/```(\w+)$/) !== null) {
                is_in_code_block = true
            }
            if (line.match(/```$/) !== null) {
                is_in_code_block = false
            }
            if (!is_in_code_block) {
                line = line.replace(c.OBS_INLINE_MATH_REGEXP, "\\($1\\)")
            }
            result += line + "\n"
        }
        note_text = result
        return note_text
    }

    cloze_repl(_1: string, match_id: string, match_content: string): string {
        if (match_id == undefined) {
            let result = "{{c" + cloze_unset_num.toString() + "::" + match_content + "}}"
            cloze_unset_num += 1
            return result
        }
        let result = "{{c" + match_id + "::" + match_content + "}}"
        return result
    }

    curly_to_cloze(text: string): string {
        /*Change text in curly brackets to Anki-formatted cloze.*/
        text = text.replace(CLOZE_REGEXP, this.cloze_repl)
        cloze_unset_num = 1
        return text
    }

    getAndFormatMedias(note_text: string): string {
        if (!(this.file_cache.hasOwnProperty("embeds"))) {
            return note_text
        }
        for (let embed of this.file_cache.embeds) {
            if (note_text.includes(embed.original)) {
                this.detectedMedia.add(embed.link)
                if (AUDIO_EXTS.includes(extname(embed.link))) {
                    note_text = note_text.replace(new RegExp(c.escapeRegex(embed.original), "g"), "[sound:" + basename(embed.link) + "]")
                } else if (IMAGE_EXTS.includes(extname(embed.link))) {
                    note_text = note_text.replace(
                        new RegExp(c.escapeRegex(embed.original), "g"),
                        '<img src="' + basename(embed.link) + '" width="' + embed.displayText + '">'
                    )
                } else {
                    console.warn("Unsupported extension: ", extname(embed.link))
                }
            }
        }
        return note_text
    }

    formatLinks(note_text: string): string {
        // 만약 [[]] 가 있으면 [[]] 처리 
        if (this.file_cache.hasOwnProperty("links")) {
            //note_text = note_text.replaceAll(/\[\[(.*?)|.*?\]\]/g, "[[$1]]") //
            for (let link of this.file_cache.links) {
                note_text = note_text.replace(new RegExp(c.escapeRegex(link.original), "g"), '<a href="' + this.getUrlFromLink(link.link) + '">' + link.displayText + "</a>")
            }
        }

        // 만약 ![[]] 가 있으면 ![[]] 처리 
        if (this.file_cache.hasOwnProperty("embeds")) {
            for (let embed of this.file_cache.embeds) {
                let matches = /!\[\[(.*?)\]\](?<!png\]\]|jpg\]\]|png\|\d+\]\]|jpg\|\d+\]\])/gm.exec(note_text) // image 가 아닌 embedding 찾기 (e.g., ![[.png]], ![[.jpg]], ![[.png|500]], ![[.jpg|500]] 를 제외하고 찾기
                if (matches === null) {
                    continue
                }
                note_text = note_text.replace(new RegExp(c.escapeRegex(embed.original), "g"), '<a href="' + this.getUrlFromLink(embed.link) + '">' + embed.displayText + "</a>")
            }
        }
        return note_text
    }

    censor(note_text: string, regexp: RegExp, mask: string): [string, string[]] {
        /*Take note_text and replace every match of regexp with mask, simultaneously adding it to a string array*/
        let matches: string[] = []
        for (let match of note_text.matchAll(regexp)) {
            matches.push(match[0])
        }
        return [note_text.replace(regexp, mask), matches]
    }

    decensor(note_text: string, mask: string, replacements: string[], escape: boolean): string {
        for (let replacement of replacements) {
            note_text = note_text.replace(
                mask, escape ? escapeHtml(replacement) : replacement
            )
        }
        return note_text
    }

    markdownTableToHtml(markdownCode: string): string {
        // 첫 줄 regex + 두번째 줄 regex + 세번째 줄 이상들의 regex
        markdownCode = markdownCode.replace(/(\|.*\|.*\|)\n\|( *[-:]+[-| :]*)+\|\n(\|.*\|.*\|\s*\n)+/g, (match, title_row, dashed_row, last_row) => {
            let rows = match.trim().split('\n').slice(2);
            rows = [title_row, ...rows]

            const htmlRows = rows.map(row => {
                const columns = row.trim().split('|').slice(1, -1).map(column => column.trim());
                const htmlColumns = columns.map(column => `<td>${column}</td>`);
                return `<tr>${htmlColumns.join('')}</tr>`;
            });
            return `<table style="border-collapse: collapse;" border="1">${htmlRows.join('')}</table>`; //border-collapse 는 cell 마다 테두리를 가지지 않고, cell 간 테두리가 1개로 나오도록 하는 style
        })
        return markdownCode
    }

    markdownCodeToHtml(markdownCode: string): string {
        markdownCode = markdownCode.trim().replace(/```(\w+)<br>([\s\S]*?)```/gm, (match, lang, code) => { // preprocessing 에서 \n 을 <br> 로 바꾸기 때문
            //prefix
            code.replace(/`/g, "(!code!)")

            //precess
            const lines = code.split("<br>");
            const m = lines[0].match(/^(\s*)([\s\S]*)$/); // 이렇게 해도 앞에 indent 를 얻는다는 것을 확인함
            const [, indent_to_remove, content] = m; //<ul> 을 통해 이미 특정 indent 에 속한 코드이기 때문에 첫줄에 해당하는 indent 는 없앤다
            let ret = ""
            for (let line of lines) {
                line = line.substring(indent_to_remove.length).replaceAll("\<", "&lt;").replaceAll("\>", "&gt;") // html code 표현을 위함
                ret += line + "\n" // css 와 highligh.min.js 를 사용할 때, anki 에서 linebreak 가 되려면, \n 이 필요함
            }

            //postfix
            code.replace(/\(!code!\)/g, "`")

            //TODO 하이픈과 코드작게 처리했고, CSS 없어진거 처리해야 함
            return `<pre><font size="3"><code class="language-${lang}">${ret}</code></font></pre>`;
            //return `<pre><code class="language-${lang}">${ret}</code></pre>`;
        });

        return markdownCode;
    }

    markdownInlineCodeToHtml(markdownCode: string): string {
        // inline code 가 있다면 그 내부 html 코드는 표현형태로 바꾼다
        markdownCode = markdownCode.replace(/(?<!`)`{1}([^`]+?)`{1}(?!`)/g, (match, code) => {
            code = code.replaceAll("\<", "&lt;").replaceAll("\>", "&gt;") // html code 표현을 위함
            code = code.replaceAll(/\$/g, "&#36;")
            return `<code>${code}</code>`
        });

        return markdownCode
    }

    preprocessing(str: string): string {
        str = str.replaceAll(/(\s\^[\w\d]{6})(?!\||\])/g, "") // [[L3. (Root) GANs#^a18e8e|(참고)]], [[L3. (Root) GANs#^a18e8e]]  와 같은 block reference 는 그대로 두고, ^3a3214 처럼 그냥 지저분한 주소만 제거하기 위한 정규식
        str = str.replaceAll(/%% OND: \d+ %%/g, "") // annotation OND 제거 (%%가 짝이 안 맞는 경우가 있기 때문에, %% 사이 %% 를 지우려 하면 안됨)
        str = str.replaceAll(/%% ID: \d+ ENDI %%/g, "") // annotation ID 제거 (%%가 짝이 안 맞는 경우가 있기 때문에, %% 사이 %% 를 지우려 하면 안됨)
        str = str.replaceAll(/(%%|)<br>STARTI[\s\S]*?Back:[\s\S]*?%%/g, "") // annotation ID 제거 (%%가 짝이 안 맞는 경우가 있기 때문에, %% 사이 %% 를 지우려 하면 안됨)
        str = str.replaceAll(/%%\d\d\d\d-\d\d-\d\d%%/g, "") // annotation date 제거 (%%가 짝이 안 맞는 경우가 있기 때문에, %% 사이 %% 를 지우려 하면 안됨)
        str = str.replaceAll(/^\s+\n/gm, "\n") // 다중 \n 하나로 변경
        str = str.replaceAll(/\n+/gm, "\n") // 다중 \n 하나로 변경
        str = str.replaceAll(/%%[\s\S]*?%%/g, "") // annotation 제거
        str = str.replaceAll(/%%/g, "") // annotation 자체 제거
        str = str.replaceAll(/<!--[\s\S]*?-->/g, "") // annotation 제거
        str = str.replaceAll(/(#)([\w가-힣\-_\/]+[\n\s])/gm, ``) // tag 를 제거
        str = str.replaceAll(/>\s*!\[\[/gm, "![[") // quote embedding 제거
        str = str.replaceAll(/(?<!\|\s*)\n(\s*)(?!\s*- |\s*\|)/g, "<br>$1") // 다음 행이 bullet 이 아닌 \n 은 모두 <br> 로 변경 (앞 뒤 table 제외)
        //str = str.replaceAll(/^---\n/gm, "<br><hr>")//<hr>
        //str = str.replaceAll(/\[\[\s+/gm, "[[") // embedding 내부 공백 제거
        //str = str.replaceAll(/\s+\]\]/gm, "]]") // embedding 내부 공백 제거
        //str = str.replaceAll(/\s*\|\s*/gm, "|") // embedding 내부 공백 제거
        // 크기 조절이 있는 png, jpg 를 HTML 로 잘 변경하도록 개선 [[예.png|500]]
        // alias 가 있는 link 는 HTML 로 잘 변경도록 개선 [[예|예1]]
        // image 가 아닌 embedding HTML 로 잘 변경도록 개선 (e.g., ![[.png]], ![[.jpg]], ![[.png|500]], ![[.jpg|500]] 를 제외하고 모두 a href link 로 잘 변경함)
        str = this.remove_common_indent(str)
        return str
    }


    toHtml(str: string): string {
        const lines = str.split("\n");
        let result = "";
        let indentLevel = -1; // 불릿이면 첫 출에도 ul 을 넣기 위함

        let is_in_code_block = false
        for (let line of lines) {
            if (line.match(/```(\w+)$/) !== null) {
                is_in_code_block = true
            }
            if (line.match(/```$/) !== null) {
                is_in_code_block = false
            }
            if (!is_in_code_block) {
                line = this.markdownInlineCodeToHtml(line)
            }

            const match = line.match(/^(\s*)(.*)$/);
            if (!match) continue;

            const [, indent, line_content] = match;
            const currIndentLevel = indent.length;

            // 필요할 때만 불릿 생성
            if (!line_content.match(/^- .*|^\d*?\. .*/gm)) { // Table 은 맨앞에 - 가 오지 않으며, 불릿이나 숫자는 indent 를 제외하면 맨 앞에 - 또는 숫자가 옴
                //if (indentLevel > currIndentLevel) { // code black 안에서 더 들여쓰기가 되면, currIndentLevel 이 더 커서 에러남
                //    result += "</ul>".repeat(indentLevel - currIndentLevel); // 불릿이 종료된 경우, indent 0으로 맞춤
                //}
                result += indent + line_content;
            }
            else {
                // indent level 조절
                if (currIndentLevel > indentLevel) {
                    result += "<ul>".repeat(currIndentLevel - indentLevel);
                } else if (currIndentLevel < indentLevel) {
                    result += "</ul>".repeat(indentLevel - currIndentLevel);
                }
                result += `<li>${line_content.trim()}</li>`;
            }

            indentLevel = currIndentLevel;
            result += "\n";
        }
        result += "</ul>".repeat(indentLevel);

        result = this.markdownTableToHtml(result)
        result = this.markdownCodeToHtml(result)
        result = result.replaceAll("<li>- ", "<li>")
        result = result.replaceAll(/\*\*(.*?)\*\*/g, "<b>$1</b>")
        result = result.replaceAll(/\[([^\[\]]+?)\]\(([^()]+?)\)/g, `<a href="$2">$1</a>`) // 한 줄에 [] 가 여러 개인 경우, 함께 match 되기 때문에 [] 내부에 []가 없도록 함

        //TTS
        //if (result.match(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣|\[|\]|]/g) === null) {
        //    result = this.html_TTS(result)
        //}
        let replace_token_list = []
        let tmp_ret = result.replaceAll(/<a.*?<\/a>/g, "") //embed, url 제외
        tmp_ret = tmp_ret.replaceAll(/<img.*?>/g, "")//image 제외
        tmp_ret = tmp_ret.replaceAll(/\[\[.*?\]\]/g, "")//혹시 모를 embedding제외
        tmp_ret = tmp_ret.replaceAll(/<code[\s\S]*?<\/code>/g, "")
        tmp_ret = tmp_ret.replaceAll(/<\math[\s\S]*?<\/math/g, "") //math 제외
        for (let match of tmp_ret.matchAll(/[a-zA-Z0-9\.\?,\-\s]+/g)) { // TTS
            if (match[0].includes("png")) {
                console.log("breakpoint")
            }
            if (match[0].length > 30) {
                let [ret, not_included_tokens] = this.isNotArraySubset(match[0].split(" "), replace_token_list)
                if (ret) {
                    result = result.replace(match[0], this.html_TTS(match[0]))
                    replace_token_list = [...replace_token_list, ...not_included_tokens]
                }
            }
        }

        return result;
    }

    isNotArraySubset(array1: any[], array2: any[]): [boolean, any[]] {
        // array1 의 60% 이상이 이전에 TTS 한 token(array2) 이면 false
        const threshold = array1.length * 0.5;
        let count = 0;
        let not_included_tokens = []
        let ret_bool = true

        for (const item of array1) {
            if (array2.includes(item)) {
                count++
                if (count >= threshold) {
                    ret_bool = false
                }
            }
            else {
                not_included_tokens.push(item)
            }
        }

        return [ret_bool, not_included_tokens]

    }


    html_TTS(str: string) {
        return `<tts service="android" voice="en_US"><u> ${str} </u></tts>`
    }

    format(note_text: string, cloze: boolean, highlights_to_cloze: boolean): string {
        note_text = this.preprocessing(note_text)
        note_text = this.obsidian_to_anki_math(note_text)
        //Extract the parts that are anki math
        let math_matches: string[]
        let inline_code_matches: string[]
        let display_code_matches: string[]
        const add_highlight_css: boolean = note_text.match(c.OBS_DISPLAY_CODE_REGEXP) ? true : false;
        [note_text, math_matches] = this.censor(note_text, ANKI_MATH_REGEXP, MATH_REPLACE);
        //[note_text, display_code_matches] = this.censor(note_text, c.OBS_DISPLAY_CODE_REGEXP, DISPLAY_CODE_REPLACE);
        //[note_text, inline_code_matches] = this.censor(note_text, c.OBS_CODE_REGEXP, INLINE_CODE_REPLACE);
        if (cloze) {
            if (highlights_to_cloze) {
                note_text = note_text.replace(HIGHLIGHT_REGEXP, "{$1}")
            }
            note_text = this.curly_to_cloze(note_text)
        }
        note_text = this.getAndFormatMedias(note_text)
        note_text = this.formatLinks(note_text)
        //Special for formatting highlights now, but want to avoid any == in code
        note_text = note_text.replace(HIGHLIGHT_REGEXP, String.raw`<mark>$1</mark>`)
        //note_text = this.decensor(note_text, DISPLAY_CODE_REPLACE, display_code_matches, false)
        //note_text = this.decensor(note_text, INLINE_CODE_REPLACE, inline_code_matches, false)
        note_text = this.decensor(note_text, MATH_REPLACE, math_matches, true)
        //note_text = converter.makeHtml(note_text)
        note_text = this.toHtml(note_text)
        // Remove unnecessary paragraph tag
        if (note_text.startsWith(PARA_OPEN) && note_text.endsWith(PARA_CLOSE)) {
            note_text = note_text.slice(PARA_OPEN.length, -1 * PARA_CLOSE.length)
        }
        if (add_highlight_css) {
            note_text = '<link href="' + c.CODE_CSS_URL + '" rel="stylesheet">' + note_text
        }
        return note_text
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

    min(a: number, b: number): number {
        return a < b ? a : b;
    }


    remove_common_indent(str: string): string {
        // 공통 indent 제거
        let min_indent_length = 100000
        let lines = str.split("\n")
        for (let line of lines) {
            let match = /^(\s*)[^\s]+/g.exec(line)
            if (match !== null) {
                let indent_length = match[1].length
                min_indent_length = this.min(min_indent_length, indent_length)
            }
        }
        if ((min_indent_length !== 0) && (min_indent_length !== 100000)) {
            let reg = new RegExp("^" + "\s".repeat(min_indent_length), "gm")
            str = str.replaceAll(reg, "")
        }
        if (min_indent_length !== 100000) {
            str = lines.map(line => line.slice(min_indent_length)).join('\n');
        }
        return str
    }




}
