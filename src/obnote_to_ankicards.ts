import { Editor, MarkdownView, TFile, App, SuggestModal, Notice, Plugin, addIcon } from 'obsidian'
import { AllFile } from './file'
import { ExtendedInlineNote } from './note'
import { error } from 'console';
import { match } from 'assert';
import { off } from 'process';

const programSymbol = `<hr class="programmers">`

interface TreeNode {
	value: string;
	children: TreeNode[];
	position: number;
}

export class TreeDictToAnkiCards {
	allFile: AllFile
	obToTreeAndDict: ObnoteToTreeAndDict

	constructor(file: AllFile) {
		this.allFile = file
		this.obToTreeAndDict = new ObnoteToTreeAndDict()
	}

	escapeRegexSymbols(pattern: string): string {
		const symbols = ['\\', '/', '.', '+', '*', '?', '|', '(', ')', '[', ']', '{', '}', '^', '$'];
		const escapedPattern = pattern.replace(new RegExp(`[${symbols.join('\\')}]`, 'g'), '\\$&');
		return escapedPattern;
	}

	findOrSetAnkiCardID(anki_front: string, position: number): number[] {
		let id = null
		// get id 맨 위에 있는 거 하나만 가져오면 안 됨 그 이유는 두 단계 불릿 중 아래 불릿만 카드를 새로 만들어야 할 때, 맨 위 불릿 id 로 처리되기 때문
		// get id 맨 아래에 있는 OND 만 가져오면 안 됨 그 이유는 위와 마찬가지로 아래 불릿만 카드를 새로 만들어야 할 때, 맨 위 불릿 id 로 처리되기 때문
		//let bullet = anki_front.match(/^\s*- [\s\S]+/gm) // 마지막 bullet 을 가져오려 했으나, bullet 안에 \n 가 있는 경우를 처리하기가 어려움
		// 두 번 연속 bullet 이 나오지 않는 bullet 만 선택하는 것으로 regex 구상함
		let bullet = anki_front.match(/(?!☰\s*- .*☰\s*- .*)☰\s*- .*|(?!\s*- .*☰\s*- .*)\s*- .*/gm) // ROOT 의 경우는 앞에 ☰ 가 없으므로 예외처리
		if (bullet !== null) {
			let id_match = /%% OND: (\d+) %%/g.exec(bullet.pop())
			if (id_match !== null) {
				id = Number(id_match[1])
			}
		}

		return [id, -position] // 후에 -position 을 찾아 다른 양식으로 추가하기 위함(ID: 1238091 양식을 1238091 로 하기 위함)
	}

	max(a: number, b: number): number {
		return a > b ? a : b;
	}

	getAnkiCardIDS(): number[] {
		let IDS = []
		for (let matches of this.allFile.file.matchAll(/%%<br>STARTI[\s\S]*?ID: (\d+?) /g)) {
			let id = Number(matches[1])
			IDS.push(id)
		}
		//let matches = /^--[\s\S]*?anki_id: (\d+)\n[\s\S]*?---\n/g.exec(this.allFile.file)
		//if (matches !== null) {
		//	IDS.push(Number(matches[1]))
		//}
		for (let matches of this.allFile.file.matchAll(/%% OND: (\d+) %%/g)) {
			let id = Number(matches[1])
			IDS.push(id)
		}
		return IDS
	}

	postprocess_file_contents(str: string): string {
		// 미리 바꾸면 ID 넣을 position 이 어긋나기 때문에 postprocess
		//str = str.replaceAll(/\!\[\[/gm, "[[") // embedding 제거
		str = str.replaceAll(/^---\n(.+:.+\n)+---\n/g, "") // frontmatter 제거
		str = str.replaceAll(/(#)([\w\-_\/]+[\n\s])/gm, ``) // tag 를 제거
		str = str.replace(/^(# )([^\n]+)\n/gm, ``) // header 1 를 제거
		str = str.replace(/\n+/gm, `\n`)
		str = str.replaceAll(new RegExp(`${programSymbol}([\\s\\S]*)${programSymbol}`, "g"), `<font size=2>--<br>$1<br>--<br></font>`) // font size 바꾸기
		return str
	}

	removeDuplicatedLine(anki_back_array: string[]): string[] {
		let ret_array = []
		// ROOT 에서 그것도 첫번째 bullet 의 윗부분이 중복되는 것이 문제이므로, 첫 번째 bullet 과 line 별로 비교해서 다른 line 만 출력함
		let standard = anki_back_array[0].split("☰")
		for (let [i, bullet] of anki_back_array.entries()) {
			if (i === 0) {
				continue
			}
			let is_bullet = false
			let match_last_bullet = ""
			try {
				match_last_bullet = bullet.match(/☰\s*- /g).pop()
			}
			catch {
				is_bullet = true // last bullet 이 없는 경우는 그냥 다 출력
			}
			for (let [j, line] of bullet.split("☰").entries()) {
				if (line === match_last_bullet) {
					is_bullet = true
				}
				if (standard[j] !== line || is_bullet) {
					ret_array = [...ret_array, line]
				}
			}
			anki_back_array[i] = ret_array.join("☰")
			ret_array = []
		}
		return anki_back_array
	}


	buildObsidianNoteToAnkiCard() {
		//let tfile = app.vault.getAbstractFileByPath(this.allFile.path) as TFile
		let text = this.allFile.file


		// exclude certain files
		let file_name = this.allFile.path.split("/").pop()
		console.log(file_name)
		let folder_path = this.allFile.path.split("/").slice(0, -1).join("/")
		let file_condition = /\(Class Diagram\)|\(Dataviewjs\)|\(Dataview\)|\(Chat\)|\(No Anki\)|\(Test\)|L0\.|L1\.|L3\.|\(T\)|\(Cleaning\)|\(Meeting\)/g.exec(file_name) !== null
		let folder_condition = /3. Private|L0\.|L1\.|L3\.|Templ|0. Inbox|No Anki|Welcome|hee-publish|Daily|Gantt|Attachment|supplement|References/gi.exec(folder_path) !== null

		if (file_condition || folder_condition) {
			this.allFile.file = this.allFile.file.replaceAll(/ %% OND: \d+ %% |%% OND: \d+ %%/g, "")
			return
		}
		let tree = null

		try {
			tree = this.obToTreeAndDict.buildTreeFromIndentContent(this.allFile.file, this.allFile.path)
		}
		catch (error) {
			new Notice(error, 50000)
			return
		}

		let [treeDict, treeDict_position] = this.obToTreeAndDict.dfsQueue(tree)

		if (Object.keys(treeDict).length === 0) {
			console.log(`Ankicard 화 되지 않는 노트가 있습니다. ${this.allFile.path}`)
		}

		// for loop with key and value of dict
		for (let [anki_front, anki_back_array] of Object.entries(treeDict)) {
			let position_ = treeDict_position[anki_front]
			let [id, position] = this.findOrSetAnkiCardID(anki_front, position_)
			anki_front = this.obToTreeAndDict.postprocessing(anki_front)
			let anki_back: string = this.obToTreeAndDict.postprocessing(this.removeDuplicatedLine(anki_back_array).join("\n"))
			text = `[Basic(MD)] **[Imagine the contents]**<br> Back: [Contents]`
			let obnote = new ExtendedInlineNote(
				text,
				this.allFile.data.fields_dict,
				this.allFile.data.curly_cloze,
				this.allFile.data.highlights_to_cloze,
				this.allFile.formatter
			)
			let parsed = obnote.parse(
				this.allFile.target_deck,
				this.allFile.url,
				this.allFile.frozen_fields_dict,
				this.allFile.data,
				this.allFile.path
			)
			parsed.identifier = id
			// post processing before converting it into HTML format
			if (anki_back.includes("코드")) {
				console.log("")
			}

			anki_front = this.postprocess_file_contents(anki_front)
			anki_back = this.postprocess_file_contents(anki_back)
			parsed.note["fields"]["Front"] += `${parsed.note["fields"]["MDContext"]}` + "<br>" + obnote.formatter.format(anki_front, false, false)
			parsed.note["fields"]["Back"] = ""
			parsed.note["fields"]["Back"] += obnote.formatter.format(anki_back, false, false)

			if (parsed.identifier == null) {
				this.allFile.inline_notes_to_add.push(parsed.note)
				this.allFile.inline_id_indexes.push(position) // 어디에 ID: 123098123 를 넣을 것인지 이때 정함
			} else if (!this.allFile.data.EXISTING_IDS.includes(id)) {
				new Notice(`OBnode to Anki with id ${parsed.identifier} does not exist in Anki!\n[FILE]\n${this.allFile.path}`, 50000)
				console.warn("OBnote to Anki with id", parsed.identifier, " in file ", this.allFile.path, " does not exist in Anki!")
			} else {
				this.allFile.notes_to_edit.push(parsed)
			}
		}

	}
}

export class ObnoteToTreeAndDict {
	getIndent(line: string): string {
		/*
		buildTreeFromIndentContent 에서 아래 행으로 관련없는 모든 행을 한 줄로 처리되게 했기 때문에 여기서는 pure indent 만 추출하면 된다.
		contentStr = contentStr.replace(/\n([\s\t]*)(?![\s\t]*- |[\s\t]*#)/g, "☰$1")
		*/
		let indent = /^(\t*)/g.exec(line)
		if (indent === null) {
			return null
		}
		else {
			return indent[1]
		}
	}

	postprocessing(str: string): string {
		return str.replace(/☰/g, "\n")
	}

	getSafePosition(line: string): number {
		// line 에서 ID 적을 포지션을 구할 때, ^12387 나 ```python ``` 가 있으면 그 앞에 적어야 에러가 없음
		let position = line.length
		let block_ref = /\s\^[\da-z]+\s*/g.exec(line) // [[a#^123|b]] 이 경우를 제외하기 위해 앞에 \s를 붙임
		let code_block = /☰\s*?```(\w)+☰[\s\S]*?```/g.exec(line)
		if (block_ref !== null && code_block !== null) {
			position = Math.min(block_ref.index, code_block.index)
		}
		else if (block_ref !== null) {
			position = block_ref.index
		}
		else if (code_block !== null) {
			position = code_block.index
		}
		else {
		}

		return position
	}

	buildTreeFromIndentContent(contentStr: string, file_path: string): TreeNode {
		// 다음 행이 - # 로 시작하지 않으면 \n 을 없애서 한줄처럼 처리되게 한다. 나중에 ☰ 을 다시 \n 으로 바꿔야 함
		// 이렇게 되면, frontmatter 가 header 위에 있는 경우, 두 줄로 처리되어 frontmatter 가 무시되게 된다. 왜냐하면 line.trim().startsWith("- ") 에서 currentValue 를 += 가 아니라 = 로 대체하기 때문이다. 하지만, frontmatter 는 어차피 의미있는 정보가 아니므로 무시해도 된다.
		//(?!\|) 는 표를 무시하기 위함
		const regreg = new RegExp(`${programSymbol}[\\s\\S]*${programSymbol}|\`\`\`\\w*\\n[\\s\\S]*?\`\`\`|(?!\\|)---\\n[\\s\\S]*?---(?!\\|)`, "g")
		contentStr = contentStr.replaceAll(regreg, (match) => {
			//contentStr = contentStr.replaceAll(/\@\@\@[\s\S]*?\@\@\@|```\w*\n[\s\S]*?```|(?!\|)---\n[\s\S]*?---(?!\|)/g, (match) => {
			match = match.replaceAll(/\n/g, "☰")
			if (/☰#/g.exec(match) !== null) {
				throw new Error(`[OBnote] ${file_path} 에서 @@@ @@@ 또는 code block 안에 # 이 있습니다. # 을 쓸 수 없습니다.`)
			}
			return match
		})
		contentStr = contentStr.replaceAll(/\n(?!\s*\-)/g, "☰")
		contentStr = contentStr.replaceAll(/☰#/g, "\n#") // 헤더는 어차피 자연스럽게 한줄로 처리되므로, 여기서는 다시 \n 을 붙여줌. 중요한건 - 의 뒷부분을 ☰ 로 변경하는 것이다. ☰ 라는 하나의 문자로 \n 와 동일한 길이로 정한 이유는 position 계산을 정확히 하기 위해서이다.
		let content = contentStr.split("\n")
		const stack: TreeNode[] = [];
		const rootNodes: TreeNode[] = [];
		let currentValue = ""
		let line_position = 0
		let offset = 0

		for (const line of content) {
			// - 가 아니면 다음에 올 - 에 한줄로 포함되도록 한다.
			if (!line.trim().startsWith("- ")) {
				if (/[^\s☰"]+/.exec(line) !== null) {
					currentValue = line + "☰"
				}
				line_position += line.length + 1
				continue
			}
			offset = this.getSafePosition(line)
			const indentLevel = this.getIndent(line);
			//if (indentLevel === null) {
			//	currentValue += line + "☰"
			//	continue
			//}


			let node = null
			if (stack.length === 0 || indentLevel.length === 0) {
				node = {
					value: currentValue + line,
					children: [],
					position: line_position + offset, // \n 에 해당하는 대채문자 ☰ 제거
				};
				rootNodes.push(node);
			} else {
				node = {
					value: line,
					children: [],
					position: line_position + offset, // \n 에 해당하는 대채문자 ☰ 제거
				};
				const parent = stack[indentLevel.length - 1];
				try {
					parent.children.push(node);
				}
				catch {
					new Notice("인덴트가 맞지 않는 노트가 있습니다. 블록과 헤더만으로 이루어진 노트만 Anki 화합니다. 일단 다음 파일로 넘어갑니다. 로그 확인", 10000)
					console.log(`인덴트가 맞지 않는 노트가 있습니다. path: ${file_path} \n${line} `)
					throw new Error(``)
				}
			}

			stack[indentLevel.length] = node;
			stack.length = indentLevel.length + 1;
			line_position += line.length + 1
		}
		// 만약 - 가 한 개도 없다면, note 전체를 그대로 root answer 로 만듬
		if (rootNodes.length === 0) {
			let node = {
				value: currentValue,
				children: [],
				position: 0 // 여기 position 은 어차피 중요하지 않아 0으로 둠. currentValue 에서 문제를 만들리 없기 때문.
			};
			rootNodes.push(node);
		}

		// get root id position
		let root_position = 0
		let front_matter_match = /^---☰(.+:.+☰)+---/g.exec(contentStr)
		if (front_matter_match !== null) {
			root_position = front_matter_match[0].length
		}
		// add root id to value if it eixsts
		let root_id = ""
		let root_Id_match = /^(%% OND: \d+ %%)/g.exec(contentStr.replace(/^---☰(.+:.+☰)+---☰/g, ""))
		if (root_Id_match !== null) {
			root_id = root_Id_match[0]
		}


		return { value: "- ROOT " + root_id, children: rootNodes, position: root_position };
	}

	// TODO ANKI [OBNOTE: ] - assign types for dict
	dfsQueue(root: TreeNode): [{ [key: string]: string[] }, {}] {
		// TODO END ANKI
		const queue: TreeNode[] = [root];
		const result: string[] = [];
		const result_QA = {}
		const result_QA_position = {} // ID 를 넣을 곳
		let front_notify = ""
		let context = []
		// root anki card 생성
		let root_value = []
		let root_key = root.value
		for (let child of root.children) {
			// 만약 child 가 있다면 문제로 만들어 질 수 있으므로, anki back 에 들어가더라도 front 에 쓰일 수 있음을 표기한다.
			front_notify = ""
			if (child.children.length !== 0) {
				front_notify = ` <font color="red">→</font>`
			}

			root_value = [...root_value, child.value + front_notify + "☰"]
		}
		result_QA[root_key] = root_value
		result_QA_position[root_key] = root.position

		while (queue.length > 0) {
			front_notify = ""
			const currentNode = queue.pop();
			let indent = this.getIndent(currentNode.value)
			// context 는 항상 한단계 위 노드까지만 보여주도록 depth 에 맞게 pop()
			while (context.length > indent.length) {
				context.pop()
			}
			// 만약 child 가 있다면 문제로 만들어 질 수 있으므로, anki back 에 들어가더라도 front 에 쓰일 수 있음을 표기한다.
			if (currentNode.children.length !== 0) {
				front_notify = ` <font color="red">→</font>`
			}
			if (context.length !== 0) {
				result.push(`[Q] ${context} [A] ${currentNode.value}`);
				// DFS 지만, key[질문] 를 이용해서 같은 level 대답은 같은 key 에 넣는다.
				let key = context.join("☰")
				try {
					result_QA[key] = [...result_QA[key], currentNode.value + front_notify]
				}
				catch (e) {
					result_QA[key] = [currentNode.value + front_notify]
				}
			}

			for (let i = currentNode.children.length - 1; i >= 0; i--) {
				queue.push(currentNode.children[i]);
			}

			context.push(currentNode.value)
			// context 가 변경될 때만 position 을 불러와야 질문의 마지막 부분 position 을 부를 수 있음
			let key = context.join("☰")
			result_QA_position[key] = currentNode.position
		}

		return [result_QA, result_QA_position]
		/* INPUT
		const tree: TreeNode = {
			value: "A",
			children: [
				{
					value: "\tA",
					children: [
						{ value: "\t\tA", children: [] },
						{ value: "\t\tB", children: [] },
					],
				},
				{
					value: "\tB",
					children: [
						{ value: "\t\tA", children: [] },
						{ value: "\t\tB", children: [] },
						{ value: "\t\tC", children: [] },
					],
				},
				{
					value: "\tC",
					children: [
						{ value: "\t\tA", children: [] },
						{ value: "\t\tB", children: [] },
					],
				},
			],
		};
		*/
		/* OUTPUT
		-A : (3) ['\t-A', '\t-B', '\t-C']
		-A,[TAB]-A : (2) ['\t\t-A', '\t\t-B']
		-A,[TAB]-B : (3) ['\t\t-A', '\t\t-B', '\t\t-C']
		-A,[TAB]-C : (2) ['\t\t-A', '\t\t-B']
		*/
	}

	test_obtoankicard(editor: Editor) {
		const tree: TreeNode = {
			value: "-A",
			children: [
				{
					value: "\t-A",
					children: [
						{ value: "\t\t-A", children: [], position: 0 },
						{ value: "\t\t-B", children: [], position: 0 },
					], position: 0
				},
				{
					value: "\t-B",
					children: [
						{ value: "\t\t-A", children: [], position: 0 },
						{ value: "\t\t-B", children: [], position: 0 },
						{ value: "\t\t-C", children: [], position: 0 },
					], position: 0
				},
				{
					value: "\t-C",
					children: [
						{ value: "\t\t-A", children: [], position: 0 },
						{ value: "\t\t-B", children: [], position: 0 },
					], position: 0
				},
			], position: 0
		};
		console.log(this.dfsQueue(tree))

		let selection = editor.getSelection()
		let tree1 = this.buildTreeFromIndentContent(selection)
		console.log(tree1)
		let [treeDict, treeDict_position] = this.dfsQueue(tree1)
		console.log(treeDict)
		for (let [key, position] of Object.entries(treeDict_position)) {
			console.log(`==key==\n${key}\n===\n\n==position value==\n${selection.slice(position - 10, position) + "IN" + selection.slice(position, position + 10)}\n===\n`)

		}

	}
}