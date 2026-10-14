/**
 * 插件入口：注册文件树视图、命令、设置页，并跟踪当前文件
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { FileView, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import { FileTreeSettingTab } from "./settings";
import { AutoRevealMode, DEFAULT_SETTINGS, FileTreeSettings, VIEW_TYPE_FILE_TREE } from "./types";
import { ExternalRevealOptions, FileTreeView } from "./view";

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

	/** 已注册面包屑拦截的 document（主窗口与各弹出窗口） */
	private readonly interceptedDocs = new WeakSet<Document>();

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
						.onClick(() => void this.revealInTree(file, { exitSearch: true })),
				);
			}),
		);
		// endregion

		// 主题亮暗切换后刷新图标
		this.registerEvent(this.app.workspace.on("css-change", () => this.getViews().forEach((v) => v.onCssChange())));

		// region 面包屑导航接管：主窗口与弹出窗口都在捕获阶段拦截点击
		this.registerBreadcrumbInterceptor(document);
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.registerBreadcrumbInterceptor(win.doc)));
		// endregion

		this.app.workspace.onLayoutReady(() => {
			// 插件启用前已经打开的弹出窗口也要注册
			this.app.workspace.iterateAllLeaves((leaf) => this.registerBreadcrumbInterceptor(leaf.view.containerEl.doc));
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
			id: "toggle-collapse-all",
			name: "全部折叠/展开",
			callback: () => this.getViews().forEach((v) => v.toggleCollapseAll()),
		});
		this.addCommand({
			id: "expand-all",
			name: "全部展开",
			callback: () => this.getViews().forEach((v) => v.expandAll()),
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
	 * 在某个窗口的 document 上注册面包屑点击拦截（同一 document 只注册一次）
	 *
	 * @param doc 窗口的 document
	 */
	private registerBreadcrumbInterceptor(doc: Document): void {
		if (this.interceptedDocs.has(doc)) {
			return;
		}
		this.interceptedDocs.add(doc);
		// 捕获阶段先于面包屑元素自身的点击监听执行
		this.registerDomEvent(doc, "click", (evt) => this.onBreadcrumbClick(evt), { capture: true });
	}

	/**
	 * 面包屑点击：开启接管时改为在文件树中定位对应文件夹
	 *
	 * @param evt 鼠标事件
	 */
	private onBreadcrumbClick(evt: MouseEvent): void {
		if (!this.settings.takeOverBreadcrumb || evt.button !== 0 || !(evt.target instanceof HTMLElement)) {
			return;
		}
		const crumbEl = evt.target.closest<HTMLElement>(".view-header-breadcrumb");
		const parentEl = crumbEl?.parentElement;
		// 库外文件的面包屑保持原生行为（在系统文件夹中打开）
		if (!crumbEl || !parentEl || parentEl.hasClass("mod-external-file")) {
			return;
		}
		const folder = this.resolveBreadcrumbFolder(crumbEl, parentEl);
		if (!folder) {
			return;
		}
		// 阻止原生跳转到自带文件列表
		evt.preventDefault();
		evt.stopImmediatePropagation();
		void this.revealInTree(folder, {
			exitSearch: true,
			expandFolder: this.settings.expandFolderOnBreadcrumb,
		});
	}

	/**
	 * 根据面包屑元素计算对应的文件夹：取所在视图当前文件的上级路径，按面包屑序号截取
	 *
	 * @param crumbEl 被点击的面包屑
	 * @param parentEl 面包屑容器
	 * @returns 文件夹，无法确定时返回 null
	 */
	private resolveBreadcrumbFolder(crumbEl: HTMLElement, parentEl: HTMLElement): TFolder | null {
		// 找到面包屑所属的文件视图
		let file: TFile | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!file && view instanceof FileView && view.file && view.containerEl.contains(crumbEl)) {
				file = view.file;
			}
		});
		const parentPath = (file as TFile | null)?.parent?.path;
		if (!parentPath || parentPath === "/") {
			return null;
		}
		// 第 N 段面包屑对应上级路径的前 N 段
		const crumbs = Array.from(parentEl.children).filter((el) => el.hasClass("view-header-breadcrumb"));
		const index = crumbs.indexOf(crumbEl);
		const segments = parentPath.split("/");
		if (index < 0 || index >= segments.length) {
			return null;
		}
		const target = this.app.vault.getAbstractFileByPath(segments.slice(0, index + 1).join("/"));
		return target instanceof TFolder ? target : null;
	}

	/**
	 * 打开文件树并定位到指定文件或文件夹，同时让文件树获得焦点
	 *
	 * @param item 文件或文件夹
	 * @param options 外部入口附加行为
	 */
	private async revealInTree(item: TAbstractFile, options: ExternalRevealOptions): Promise<void> {
		const view = await this.activateView();
		if (!view) {
			return;
		}
		this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		view.revealFile(item, options);
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
