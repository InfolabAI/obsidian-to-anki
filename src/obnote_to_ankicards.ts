import { Editor, MarkdownView, TFile, App, SuggestModal, Notice, Plugin, addIcon } from 'obsidian'
import { AllFile } from './file'
import { ExtendedInlineNote } from './note'
import { error } from 'console';
import { match } from 'assert';
import { off } from 'process';

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
		// get id 맨 위에 있는 거 하나만 가져오면 되기에 exec 를 사용
		for (let match_id of anki_front.matchAll(/%% OND: (\d+) %%/g)) {
			id = Number(match_id[1])
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
		str = str.replaceAll(/^---\n[\s\S]*?\n---\n/g, "") // frontmatter 제거
		str = str.replaceAll(/(#)([\w\-_\/]+[\n\s])/gm, ``) // tag 를 제거
		str = str.replace(/^(# )([^\n]+)\n/gm, ``) // header 1 를 제거
		return str
	}

	buildObsidianNoteToAnkiCard() {
		//let tfile = app.vault.getAbstractFileByPath(this.allFile.path) as TFile
		let text = this.allFile.file

		// exclude certain files
		let file_name = this.allFile.path.split("/").pop()
		let folder_path = this.allFile.path.split("/").slice(0, -1).join("/")
		let file_condition = /\(Test\)|L0\.|L1\.|L3\.|\(T\)|\(Cleaning\)|\(Meeting\)/g.exec(file_name) !== null
		let folder_condition = /3. Private|L0\.|L1\.|L3\.|Templ|0. Inbox|Welcome|hee-publish|Daily|Gantt|Attachment|supplement|References/gi.exec(folder_path) !== null

		if (file_condition || folder_condition) {
			this.allFile.file = this.allFile.file.replaceAll(/^---\n---\n/g, "")
			this.allFile.file = this.allFile.file.replaceAll(/^---\nanki_id: \d*?\n---\n/g, "")
			this.allFile.file = this.allFile.file.replaceAll(/^anki_id: \d*?\n/gm, "")
			return
		}
		let tree = null
		try {
			tree = this.obToTreeAndDict.buildTreeFromIndentContent(this.allFile.file, this.allFile.path)
		}
		catch {
			return
		}

		let [treeDict, treeDict_position] = this.obToTreeAndDict.dfsQueue(tree)

		if (Object.keys(treeDict).length === 0) {
			console.log(`Ankicard 화 되지 않는 노트가 있습니다. ${this.allFile.path}`)
		}

		// for loop with key and value of dict
		for (let [anki_front, anki_back_array] of Object.entries(treeDict)) {
			let position_ = treeDict_position[anki_front]
			anki_front = this.obToTreeAndDict.postprocessing(anki_front)
			let anki_back: string = this.obToTreeAndDict.postprocessing(anki_back_array.join("\n"))
			text = `[Basic(MD)] **[Imagine the contents]**<br> Back: [Contents]`
			let [id, position] = this.findOrSetAnkiCardID(anki_front, position_)
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
			if (anki_back.includes("매우 느린데")) {
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
		let block_ref = /\^\d+\s*/g.exec(line)
		let code_block = /☰\t*?```(\w)+☰[\s\S]*?```/g.exec(line)
		if (block_ref !== null) {
			position -= block_ref[0].length
		}
		if (code_block !== null) {
			position -= code_block[0].length
		}

		return position
	}

	buildTreeFromIndentContent(contentStr: string, file_path: string): TreeNode {
		// 다음 행이 - # 로 시작하지 않으면 \n 을 없애서 한줄처럼 처리되게 한다. 나중에 ☰ 을 다시 \n 으로 바꿔야 함
		// 이렇게 되면, frontmatter 가 header 위에 있는 경우, 두 줄로 처리되어 frontmatter 가 무시되게 된다. 왜냐하면 line.trim().startsWith("- ") 에서 currentValue 를 += 가 아니라 = 로 대체하기 때문이다. 하지만, frontmatter 는 어차피 의미있는 정보가 아니므로 무시해도 된다.
		contentStr = contentStr.replaceAll(/\n([\t]*)(?![\t]*- )/g, "☰$1")
		contentStr = contentStr.replaceAll(/☰#/g, "\n#")
		let content = contentStr.split("\n")
		const stack: TreeNode[] = [];
		const rootNodes: TreeNode[] = [];
		let currentValue = ""
		let line_position = 0
		let offset = 0

		for (const line of content) {
			// - 가 아니면 다음에 올 - 에 한줄로 포함되도록 한다.
			if (!line.trim().startsWith("- ")) {
				currentValue = line + "☰"
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

		// get root id position
		let root_position = 0
		let front_matter_match = /^---☰[\s\S]*?☰---/g.exec(contentStr)
		if (front_matter_match !== null) {
			root_position = front_matter_match[0].length
		}
		// add root id to value if it eixsts
		let root_id = ""
		let root_Id_match = /^(%% OND: \d+ %%)/g.exec(contentStr.replace(/^---☰[\s\S]*?☰---☰/g, ""))
		if (root_Id_match !== null) {
			root_id = root_Id_match[0]
		}


		return { value: "- ROOT " + root_id, children: rootNodes, position: root_position };
	}


	dfsQueue(root: TreeNode): [{}, {}] {
		const queue: TreeNode[] = [root];
		const result: string[] = [];
		const result_QA = {}
		const result_QA_position = {} // ID 를 넣을 곳
		let context = []
		// root anki card 생성
		let root_value = []
		let root_key = root.value
		for (let child of root.children) {
			root_value = [...root_value, child.value + "☰"]
		}
		result_QA[root_key] = root_value
		result_QA_position[root_key] = root.position

		while (queue.length > 0) {
			const currentNode = queue.pop();
			let indent = this.getIndent(currentNode.value)
			// context 는 항상 한단계 위 노드까지만 보여주도록 depth 에 맞게 pop()
			while (context.length > indent.length) {
				context.pop()
			}
			if (context.length !== 0) {
				result.push(`[Q] ${context} [A] ${currentNode.value}`);
				// DFS 지만, key[질문] 를 이용해서 같은 level 대답은 같은 key 에 넣는다.
				let key = context.join("☰")
				try {
					result_QA[key] = [...result_QA[key], currentNode.value]
				}
				catch (e) {
					result_QA[key] = [currentNode.value]
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