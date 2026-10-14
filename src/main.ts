/**
 * 插件入口：注册文件树视图、命令、设置页，并跟踪当前文件
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { FileView, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { FileTreeSettingTab } from "./settings";
import { AutoRevealMode, DEFAULT_SETTINGS, FileTreeSettings, VIEW_TYPE_FILE_TREE } from "./types";
import { FileTreeView } from "./view";

/**
 * 类 VSCode 文件树插件
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export default class VscodeFileTreePlugin extends Plugin {
	/** 插件配置 */
	settings: FileTreeSettings = { ...DEFAULT_SETTINGS };
	/** 当前文件（主编辑区最近激活的文件；焦点在侧边栏时保持不变） */
	currentFile: TFile | null = null;

	/** 防抖保存视图状态，避免滚动、展开时频繁写盘 */
	private readonly saveStateDebounced = debounce(() => void this.saveData(this.settings), 1000, true);

	/**
	 * 插件加载
	 */
	async onload(): Promise<void> {
		await this.loadSettings();

		// region 视图、图标、命令、设置页
		this.registerView(VIEW_TYPE_FILE_TREE, (leaf) => new FileTreeView(leaf, this));
		this.addRibbonIcon("folder-tree", "打开文件树", () => void this.activateView());
		this.registerCommands();
		this.addSettingTab(new FileTreeSettingTab(this.app, this));
		// endregion

		// region 跟踪当前文件
		// 切换标签页：只跟踪主编辑区（含弹出窗口），侧边栏获得焦点时不改变当前文件
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.onActiveLeafChange(leaf)));
		// 同一标签页内打开另一个文件
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.setCurrentFile(file);
				}
			}),
		);
		// endregion

		// region 其他视图的文件菜单：增加“在文件树中显示”
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
				// 本插件自己的菜单不加
				if (leaf?.view instanceof FileTreeView) {
					return;
				}
				menu.addItem((item) =>
					item
						.setSection("system")
						.setTitle("在文件树中显示")
						.setIcon("folder-tree")
						.onClick(async () => {
							const view = await this.activateView();
							view?.revealFile(file);
						}),
				);
			}),
		);
		// endregion

		// 主题亮暗切换后刷新图标
		this.registerEvent(this.app.workspace.on("css-change", () => this.getViews().forEach((v) => v.onCssChange())));

		this.app.workspace.onLayoutReady(() => {
			this.currentFile = this.app.workspace.getActiveFile();
			if (this.settings.openOnStartup) {
				void this.ensureView();
			}
		});
	}

	/**
	 * 注册命令
	 */
	private registerCommands(): void {
		this.addCommand({
			id: "open-file-tree",
			name: "打开文件树",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "reveal-active-file",
			name: "在文件树中定位当前文件",
			callback: async () => {
				const view = await this.activateView();
				view?.revealActiveFile();
			},
		});
		this.addCommand({
			id: "toggle-auto-reveal",
			name: "切换自动显示当前文件",
			callback: async () => {
				const s = this.settings;
				await this.setAutoRevealMode(s.autoRevealMode === AutoRevealMode.Off ? s.lastAutoRevealMode : AutoRevealMode.Off);
			},
		});
		this.addCommand({
			id: "collapse-all",
			name: "全部折叠",
			callback: () => this.getViews().forEach((v) => v.collapseAll()),
		});
		this.addCommand({
			id: "search",
			name: "在文件树中搜索",
			callback: async () => {
				const view = await this.activateView();
				view?.toggleSearch(true);
			},
		});
		this.addCommand({
			id: "new-note",
			name: "新建笔记（文件树）",
			callback: async () => {
				const view = await this.activateView();
				await view?.createNote();
			},
		});
		this.addCommand({
			id: "new-folder",
			name: "新建文件夹（文件树）",
			callback: async () => {
				const view = await this.activateView();
				await view?.createFolder();
			},
		});
	}

	/**
	 * 激活叶子变化时更新当前文件
	 *
	 * @param leaf 新激活的叶子
	 */
	private onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		if (!leaf) {
			return;
		}
		// 左右侧边栏中的视图不改变当前文件
		const root = leaf.getRoot();
		if (root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit) {
			return;
		}
		// 空标签页、关系图谱等不对应文件的视图保留上一次的当前文件
		const view = leaf.view;
		if (view instanceof FileView && view.file) {
			this.setCurrentFile(view.file);
		}
	}

	/**
	 * 更新当前文件并通知所有文件树视图
	 *
	 * @param file 当前文件
	 */
	private setCurrentFile(file: TFile): void {
		this.currentFile = file;
		this.getViews().forEach((v) => v.onActiveFileChange(file));
	}

	/**
	 * 获取所有已加载的文件树视图（延迟加载、尚未显示的不算）
	 *
	 * @returns 视图列表
	 */
	getViews(): FileTreeView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_FILE_TREE)
			.map((leaf) => leaf.view)
			.filter((view): view is FileTreeView => view instanceof FileTreeView);
	}

	/**
	 * 启动时确保左侧边栏存在文件树（不抢占焦点）
	 */
	private async ensureView(): Promise<void> {
		if (this.app.workspace.getLeavesOfType(VIEW_TYPE_FILE_TREE).length > 0) {
			return;
		}
		const leaf = this.app.workspace.getLeftLeaf(false);
		await leaf?.setViewState({ type: VIEW_TYPE_FILE_TREE, active: false });
	}

	/**
	 * 打开并显示文件树
	 *
	 * @returns 文件树视图，失败返回 null
	 */
	async activateView(): Promise<FileTreeView | null> {
		const workspace = this.app.workspace;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_FILE_TREE)[0] ?? null;
		// 不存在则在左侧边栏新建
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			if (!leaf) {
				return null;
			}
			await leaf.setViewState({ type: VIEW_TYPE_FILE_TREE, active: true });
		}
		await workspace.revealLeaf(leaf);
		// 延迟加载的视图在显示后才会实例化
		return leaf.view instanceof FileTreeView ? leaf.view : null;
	}

	/**
	 * 设置自动定位模式（工具栏、命令、设置页共用）
	 *
	 * @param mode 新模式
	 */
	async setAutoRevealMode(mode: AutoRevealMode): Promise<void> {
		this.settings.autoRevealMode = mode;
		// 记住最后一次开启的模式，供开关切回
		if (mode !== AutoRevealMode.Off) {
			this.settings.lastAutoRevealMode = mode;
		}
		await this.saveSettings();
	}

	/**
	 * 读取配置
	 */
	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<FileTreeSettings>;
		// 数组字段深拷贝，避免修改默认值
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			filterExtensions: [...(data.filterExtensions ?? [])],
			hiddenFolders: [...(data.hiddenFolders ?? [])],
			revealExcludedFolders: [...(data.revealExcludedFolders ?? [])],
			expandedFolders: [...(data.expandedFolders ?? [])],
		};
	}

	/**
	 * 保存配置并刷新视图
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.getViews().forEach((v) => v.onSettingsChanged());
	}

	/**
	 * 请求保存视图状态（防抖，不刷新视图）
	 */
	requestSaveState(): void {
		this.saveStateDebounced();
	}

	/**
	 * 插件卸载时立即落盘未保存的状态
	 */
	onunload(): void {
		this.saveStateDebounced.run();
	}
}
