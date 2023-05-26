import { Editor, MarkdownView, TFile, App, SuggestModal, Notice, Plugin, addIcon } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings, ParsedSettings } from './src/interfaces/settings-interface'
import { SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'
import { settingToData } from './src/setting-to-data'
import { FileManager } from './src/files-manager'
import { Backlinks } from './src/backlinks'

class SuggestBacklinks extends SuggestModal<string> {
	// backlinks 를 얻고 suggest 후 선택하면, 해당 backlink 로 이동함
	editor: Editor
	view: MarkdownView

	constructor(app: App, editor: Editor, view: MarkdownView) {
		super(app);
		this.editor = editor
		this.view = view
	}

	getSuggestions(query: string): string[] | Promise<string[]> {
		let file = app.workspace.getActiveFile()
		if (app.metadataCache['resolvedBackLinks'][file.path] != null) {
			return Object.keys(app.metadataCache['resolvedBackLinks'][file.path]) // Return backlinks
		}
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.createEl("div", { text: value })
	}

	async onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
		let file = this.openFileByPath(item)
		await this.app.workspace.openLinkText(
			file.basename,
			"",
			false, // No new tab
			{ state: { mode: "source" } }
		);
		const activeView =
			this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!activeView) {
			new Notice("No active markdown editor found.");
			return;
		}

		activeView.editor.focus();
		new Notice(`Backlink is opened`);
	}

	openFileByPath(filePath: string): TFile {
		// 경로의 md 파일 open
		const file = app.vault.getAbstractFileByPath(filePath) as TFile;
		if (file === null) {
			new Notice(`There is no file at path ${filePath}. You need to create the file first.`);
			throw new Error(`There is no file at path ${filePath}. You need to create the file first.`);
		}

		return file;
	}
}

export default class MyPlugin extends Plugin {

	settings: PluginSettings
	note_types: Array<string>
	fields_dict: Record<string, string[]>
	added_media: string[]
	file_hashes: Record<string, string>

	//sdflkj
	async getDefaultSettings(): Promise<PluginSettings> {
		let settings: PluginSettings = {
			CUSTOM_REGEXPS: {},
			FILE_LINK_FIELDS: {},
			CONTEXT_FIELDS: {},
			FOLDER_DECKS: {},
			FOLDER_TAGS: {},
			Syntax: {
				"Begin Note": "START",
				"End Note": "END",
				"Begin Inline Note": "STARTI",
				"End Inline Note": "ENDI",
				"Target Deck Line": "TARGET DECK",
				"File Tags Line": "FILE TAGS",
				"Delete Note Line": "DELETE",
				"Frozen Fields Line": "FROZEN"
			},
			Defaults: {
				"Tag": "Obsidian_to_Anki",
				"Deck": "Default",
				"Scheduling Interval": 0,
				"Add File Link": false,
				"Add Context": false,
				"CurlyCloze": false,
				"CurlyCloze - Highlights to Clozes": false,
				"ID Comments": true,
				"Add Obsidian Tags": false,
			}
		}
		/*Making settings from scratch, so need note types*/
		this.note_types = await AnkiConnect.invoke('modelNames') as Array<string>
		this.fields_dict = await this.generateFieldsDict()
		for (let note_type of this.note_types) {
			settings["CUSTOM_REGEXPS"][note_type] = ""
			const field_names: string[] = await AnkiConnect.invoke(
				'modelFieldNames', { modelName: note_type }
			) as string[]
			this.fields_dict[note_type] = field_names
			settings["FILE_LINK_FIELDS"][note_type] = field_names[0]
		}
		return settings
	}

	async generateFieldsDict(): Promise<Record<string, string[]>> {
		let fields_dict = {}
		for (let note_type of this.note_types) {
			const field_names: string[] = await AnkiConnect.invoke(
				'modelFieldNames', { modelName: note_type }
			) as string[]
			fields_dict[note_type] = field_names
		}
		return fields_dict
	}

	async saveDefault(): Promise<void> {
		const default_sets = await this.getDefaultSettings()
		this.saveData(
			{
				settings: default_sets,
				"Added Media": [],
				"File Hashes": {},
				fields_dict: {}
			}
		)
	}

	async loadSettings(): Promise<PluginSettings> {
		let current_data = await this.loadData()
		if (current_data == null || Object.keys(current_data).length != 4) {
			new Notice("Need to connect to Anki generate default settings...")
			const default_sets = await this.getDefaultSettings()
			this.saveData(
				{
					settings: default_sets,
					"Added Media": [],
					"File Hashes": {},
					fields_dict: {}
				}
			)
			new Notice("Default settings successfully generated!")
			return default_sets
		} else {
			return current_data.settings
		}
	}

	async loadAddedMedia(): Promise<string[]> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			return []
		} else {
			return current_data["Added Media"]
		}
	}

	async loadFileHashes(): Promise<Record<string, string>> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			return {}
		} else {
			return current_data["File Hashes"]
		}
	}

	async loadFieldsDict(): Promise<Record<string, string[]>> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			const fields_dict = await this.generateFieldsDict()
			return fields_dict
		}
		return current_data.fields_dict
	}

	async saveAllData(): Promise<void> {
		this.saveData(
			{
				settings: this.settings,
				"Added Media": this.added_media,
				"File Hashes": this.file_hashes,
				fields_dict: this.fields_dict
			}
		)
	}

	regenerateSettingsRegexps() {
		let regexp_section = this.settings["CUSTOM_REGEXPS"]
		// For new note types
		for (let note_type of this.note_types) {
			this.settings["CUSTOM_REGEXPS"][note_type] = regexp_section.hasOwnProperty(note_type) ? regexp_section[note_type] : ""
		}
		// Removing old note types
		for (let note_type of Object.keys(this.settings["CUSTOM_REGEXPS"])) {
			if (!this.note_types.includes(note_type)) {
				delete this.settings["CUSTOM_REGEXPS"][note_type]
			}
		}
	}

	async scanVault(option: string) {
		let backlinks: Backlinks = new Backlinks()
		backlinks.getBackLinks_hcustom()

		new Notice('Scanning vault, check console for details...');
		console.info("Checking connection to Anki...")
		try {
			await AnkiConnect.invoke('modelNames')
		}
		catch (e) {
			new Notice("Error, couldn't connect to Anki! Check console for error message.")
			return
		}
		new Notice("Successfully connected to Anki! This could take a few minutes - please don't close Anki until the plugin is finished")
		const data: ParsedSettings = await settingToData(this.app, this.settings, this.fields_dict)
		let manager = new FileManager(this.app, data, this.app.vault.getMarkdownFiles(), this.file_hashes, this.added_media)
		await manager.initialiseFiles()
		let ret = await manager.requests_hee()
		new Notice("Automatic deletion process is done. Now we are scanning the vault again.")
		console.log(ret)

		manager = new FileManager(this.app, data, this.app.vault.getMarkdownFiles(), this.file_hashes, this.added_media)
		await manager.initialiseFiles()
		await manager.requests_1()
		this.added_media = Array.from(manager.added_media_set)
		const hashes = manager.getHashes()
		for (let key in hashes) {
			this.file_hashes[key] = hashes[key]
		}
		new Notice("All done! Saving file hashes and added media now...")
		this.saveAllData()
	}

	async onload() {
		console.log('loading Obsidian_to_Anki...');
		addIcon('anki', ANKI_ICON)

		try {
			this.settings = await this.loadSettings()
		}
		catch (e) {
			new Notice("Couldn't connect to Anki! Check console for error message.")
			return
		}

		this.note_types = Object.keys(this.settings["CUSTOM_REGEXPS"])
		this.fields_dict = await this.loadFieldsDict()
		if (Object.keys(this.fields_dict).length == 0) {
			new Notice('Need to connect to Anki to generate fields dictionary...')
			try {
				this.fields_dict = await this.generateFieldsDict()
				new Notice("Fields dictionary successfully generated!")
			}
			catch (e) {
				new Notice("Couldn't connect to Anki! Check console for error message.")
				return
			}
		}
		this.added_media = await this.loadAddedMedia()
		this.file_hashes = await this.loadFileHashes()

		this.addSettingTab(new SettingsTab(this.app, this));

		this.addRibbonIcon('anki', 'Obsidian_to_Anki - Scan Vault', async () => {
			await this.scanVault()
		})

		this.addCommand({
			id: 'anki-scan-vault',
			name: 'Scan Vault',
			callback: async () => {
				await this.scanVault()
			}
		})
		this.addCommand({
			id: 'go_to_backlinks',
			name: 'Go To Backlinks',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				let backlinks: Backlinks = new Backlinks()
				backlinks.getBackLinks_hcustom()

				await new SuggestBacklinks(app, editor, view).open()
			}
		})
	}

	async onunload() {
		console.log("Saving settings for Obsidian_to_Anki...")
		this.saveAllData()
		console.log('unloading Obsidian_to_Anki...');
	}
}
