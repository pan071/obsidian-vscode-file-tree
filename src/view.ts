/**
 * 文件树侧边栏视图：渲染、自动定位当前文件、选择与键盘导航、行内重命名、拖拽、右键菜单、搜索
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import {
	ItemView,
	Keymap,
	Menu,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from "obsidian";
import { FileActions } from "./actions";
import { IconRenderer } from "./icons";
import { DragData, DropResult, addFileMenuSections, getDragManager, isExtensionSupported } from "./internal";
import type VscodeFileTreePlugin from "./main";
import { TreeModel, getAncestorPaths, isUnderFolders } from "./model";
import {
	AutoRevealMode,
	ClickOpenMode,
	FILE_MENU_SOURCE,
	IconSource,
	NameDisplayMode,
	ScrollAlign,
	SearchScope,
	SortOrder,
	VIEW_TYPE_FILE_TREE,
} from "./types";

/**
 * 一行的渲染引用（紧凑文件夹链中的每个路径都指向同一行）
 */
interface RowRef {
	/** 行对应的文件或文件夹（紧凑链为链尾文件夹） */
	item: TAbstractFile;
	/** 紧凑链的链头（非紧凑时等于 item） */
	head: TAbstractFile;
	/** 外层元素（包含子项容器） */
	itemEl: HTMLElement;
	/** 行元素 */
	selfEl: HTMLElement;
	/** 折叠箭头 */
	chevronEl: HTMLElement;
	/** 图标容器 */
	iconEl: HTMLElement | null;
	/** 名称元素 */
	labelEl: HTMLElement;
	/** 子项容器（仅文件夹） */
	childrenEl: HTMLElement | null;
	/** 缩进层级 */
	depth: number;
}

/**
 * 定位参数
 */
interface RevealOptions {
	/** 是否展开上级文件夹 */
	expand: boolean;
	/** 是否滚动到可见 */
	scroll: boolean;
	/** 是否折叠无关文件夹 */
	collapseOthers: boolean;
	/** 是否遵守手动滚动保护时间 */
	guard: boolean;
}

/** 自动定位模式的中文名称 */
export const AUTO_REVEAL_LABELS: Record<AutoRevealMode, string> = {
	[AutoRevealMode.Off]: "关闭",
	[AutoRevealMode.ExpandAndScroll]: "展开并滚动",
	[AutoRevealMode.ExpandOnly]: "展开但不滚动",
	[AutoRevealMode.HighlightOnly]: "只高亮",
};

/** 排序方式的中文名称 */
export const SORT_LABELS: Record<SortOrder, string> = {
	[SortOrder.NameAsc]: "文件名（A 到 Z）",
	[SortOrder.NameDesc]: "文件名（Z 到 A）",
	[SortOrder.ModifiedDesc]: "修改时间（新到旧）",
	[SortOrder.ModifiedAsc]: "修改时间（旧到新）",
	[SortOrder.CreatedDesc]: "创建时间（新到旧）",
	[SortOrder.CreatedAsc]: "创建时间（旧到新）",
};

/** 拖拽悬停自动展开文件夹的延迟（毫秒） */
const HOVER_EXPAND_DELAY = 750;
/** 行高亮样式：拖拽悬停目标 */
const DRAG_OVER_CLASS = "is-being-dragged-over";

/**
 * 文件树视图
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export class FileTreeView extends ItemView {
	/** 插件实例 */
	private readonly plugin: VscodeFileTreePlugin;
	/** 数据模型 */
	private readonly model: TreeModel;
	/** 图标渲染器 */
	private readonly icons: IconRenderer;
	/** 文件操作 */
	private readonly actions: FileActions;

	// region DOM
	/** 搜索框外层 */
	private searchWrapEl!: HTMLElement;
	/** 搜索输入框 */
	private searchInputEl!: HTMLInputElement;
	/** 搜索按钮 */
	private searchButtonEl!: HTMLElement;
	/** 自动定位按钮 */
	private autoRevealButtonEl!: HTMLElement;
	/** 全部折叠/展开切换按钮 */
	private collapseButtonEl!: HTMLElement;
	/** 滚动容器 */
	private scrollEl!: HTMLElement;
	/** 树容器 */
	private treeEl!: HTMLElement;
	/** 监听视图显示/隐藏 */
	private resizeObserver: ResizeObserver | null = null;
	// endregion

	// region 树状态
	/** 路径 → 行引用 */
	private readonly rows = new Map<string, RowRef>();
	/** 已展开的文件夹 */
	private expanded = new Set<string>();
	/** 根节点是否折叠（仅显示根节点时有效） */
	private rootCollapsed = false;
	/** 搜索时被手动折叠的文件夹 */
	private readonly searchCollapsed = new Set<string>();
	/** 搜索时被手动展开的文件夹（与 expanded 分开，退出搜索后不影响原展开状态） */
	private readonly searchOpened = new Set<string>();
	/** 当前搜索文本 */
	private searchQuery = "";
	/** 进入搜索前的滚动位置 */
	private preSearchScrollTop: number | null = null;
	// endregion

	// region 选择状态
	/** 当前文件路径（高亮） */
	private activePath: string | null = null;
	/** 键盘焦点所在行 */
	private focusedPath: string | null = null;
	/** Shift 连选的起点 */
	private anchorPath: string | null = null;
	/** 多选集合 */
	private readonly selected = new Set<string>();
	// endregion

	// region 交互状态
	/** 正在行内重命名的路径 */
	private renamingPath: string | null = null;
	/** 重命名期间被推迟的整树渲染 */
	private pendingRender = false;
	/** 视图隐藏期间被推迟的自动定位 */
	private pendingReveal = false;
	/** 渲染完成后需要自动定位（当前文件被重命名或移动时） */
	private revealAfterRender = false;
	/** 最近一次手动滚动的时间 */
	private lastUserScrollAt = 0;
	/** 由树内点击触发打开的文件路径（这次文件切换不再定位） */
	private openingFromTreePath: string | null = null;
	/** 清理 openingFromTreePath 的定时器 */
	private openingTimer: number | null = null;
	/** 拖拽悬停的文件夹路径 */
	private hoverExpandPath: string | null = null;
	/** 拖拽悬停展开定时器 */
	private hoverExpandTimer: number | null = null;
	// endregion

	/** 防抖整树渲染（库文件变化时） */
	private readonly scheduleRender = debounce(() => this.renderTree(), 100, true);
	/** 防抖应用搜索 */
	private readonly scheduleSearch = debounce((value: string) => this.setSearchQuery(value), 150, true);

	/**
	 * 创建视图
	 *
	 * @param leaf 所在叶子
	 * @param plugin 插件实例
	 */
	constructor(leaf: WorkspaceLeaf, plugin: VscodeFileTreePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.model = new TreeModel(this.app.vault, plugin.settings);
		this.icons = new IconRenderer(this.app);
		this.actions = new FileActions(plugin);
	}

	/**
	 * 视图类型
	 *
	 * @returns 视图类型标识
	 */
	getViewType(): string {
		return VIEW_TYPE_FILE_TREE;
	}

	/**
	 * 视图标题
	 *
	 * @returns 标题
	 */
	getDisplayText(): string {
		return "文件树";
	}

	/**
	 * 视图图标
	 *
	 * @returns 图标名
	 */
	getIcon(): string {
		return "folder-tree";
	}

	/**
	 * 打开视图：搭建 DOM、注册事件并完成首次渲染
	 */
	async onOpen(): Promise<void> {
		const settings = this.plugin.settings;
		this.contentEl.empty();
		this.contentEl.addClass("vft-view");

		this.buildHeader();
		this.buildSearch();
		this.updateHeaderState();

		// region 滚动容器与树
		this.scrollEl = this.contentEl.createDiv({ cls: "vft-scroll", attr: { tabindex: "0" } });
		this.treeEl = this.scrollEl.createDiv({ cls: "vft-tree" });
		// endregion

		this.registerTreeEvents();
		this.registerDropTarget();
		this.registerVaultEvents();

		// 视图从隐藏变为可见时补做被推迟的定位
		this.resizeObserver = new ResizeObserver(() => {
			if (this.pendingReveal && this.containerEl.isShown()) {
				this.autoReveal(false);
			}
		});
		this.resizeObserver.observe(this.containerEl);

		// 恢复上次的展开状态
		if (settings.rememberState) {
			this.expanded = new Set(settings.expandedFolders);
		}

		// 布局就绪（库已加载）后再做首次渲染
		this.app.workspace.onLayoutReady(() => {
			this.activePath = this.plugin.currentFile?.path ?? null;
			this.renderTree();
			if (settings.rememberState) {
				this.scrollEl.scrollTop = settings.scrollTop;
			}
			// 首次定位不受滚动保护影响
			this.autoReveal(false);
		});
	}

	/**
	 * 关闭视图：保存状态并释放监听
	 */
	async onClose(): Promise<void> {
		this.saveState();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.clearHoverExpand();
		if (this.openingTimer !== null) {
			window.clearTimeout(this.openingTimer);
		}
	}

	// region 头部工具栏与搜索框

	/**
	 * 搭建头部工具栏
	 */
	private buildHeader(): void {
		const header = this.contentEl.createDiv({ cls: "nav-header vft-header" });
		const buttons = header.createDiv({ cls: "nav-buttons-container" });

		this.addHeaderButton(buttons, "edit", "新建笔记", () => void this.createNote());
		this.addHeaderButton(buttons, "folder-plus", "新建文件夹", () => void this.createFolder());
		this.addHeaderButton(buttons, "arrow-up-narrow-wide", "排序方式", (evt) => this.showSortMenu(evt));
		this.autoRevealButtonEl = this.addHeaderButton(buttons, "gallery-vertical", "自动显示当前文件", () =>
			void this.toggleAutoReveal(),
		);
		// 右键自动定位按钮可直接选择模式
		this.autoRevealButtonEl.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showAutoRevealMenu(evt);
		});
		this.addHeaderButton(buttons, "locate-fixed", "定位当前文件", () => this.revealActiveFile());
		// 单按钮切换：有展开的文件夹时全部折叠，否则全部展开
		this.collapseButtonEl = this.addHeaderButton(buttons, "chevrons-down-up", "全部折叠", () => this.toggleCollapseAll());
		this.searchButtonEl = this.addHeaderButton(buttons, "search", "搜索", () => this.toggleSearch());
	}

	/**
	 * 添加一个工具栏按钮
	 *
	 * @param parent 按钮容器
	 * @param icon 图标名
	 * @param tooltip 提示文字
	 * @param onClick 点击回调
	 * @returns 按钮元素
	 */
	private addHeaderButton(parent: HTMLElement, icon: string, tooltip: string, onClick: (evt: MouseEvent) => void): HTMLElement {
		const btn = parent.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": tooltip } });
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
		return btn;
	}

	/**
	 * 刷新工具栏按钮的激活状态
	 */
	private updateHeaderState(): void {
		const mode = this.plugin.settings.autoRevealMode;
		const on = mode !== AutoRevealMode.Off;
		this.autoRevealButtonEl.toggleClass("is-active", on);
		this.autoRevealButtonEl.setAttr(
			"aria-label",
			`自动显示当前文件：${AUTO_REVEAL_LABELS[on ? mode : AutoRevealMode.Off]}（右键切换模式）`,
		);
		this.searchButtonEl.toggleClass("is-active", this.searchWrapEl.isShown());
	}

	/**
	 * 搭建搜索框（默认隐藏）
	 */
	private buildSearch(): void {
		this.searchWrapEl = this.contentEl.createDiv({ cls: "search-input-container vft-search" });
		this.searchInputEl = this.searchWrapEl.createEl("input", {
			type: "search",
			attr: { placeholder: "搜索文件名，空格分隔多个关键词", spellcheck: "false" },
		});
		const clearEl = this.searchWrapEl.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "清空" } });
		this.searchWrapEl.hide();

		this.searchInputEl.addEventListener("input", () => this.scheduleSearch(this.searchInputEl.value));
		this.searchInputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Escape") {
				// 有内容先清空，再按一次收起
				evt.preventDefault();
				if (this.searchInputEl.value) {
					this.clearSearchInput();
				} else {
					this.toggleSearch(false);
				}
			} else if (evt.key === "ArrowDown" || evt.key === "Enter") {
				// 跳到第一条结果
				evt.preventDefault();
				this.scheduleSearch.run();
				const first = this.getRowEls()[0];
				if (first?.dataset.path) {
					this.setFocus(first.dataset.path, true);
					this.scrollEl.focus({ preventScroll: true });
				}
			}
		});
		clearEl.addEventListener("click", () => this.clearSearchInput());
	}

	/**
	 * 清空搜索框
	 */
	private clearSearchInput(): void {
		this.searchInputEl.value = "";
		this.scheduleSearch.cancel();
		this.setSearchQuery("");
		this.searchInputEl.focus();
	}

	/**
	 * 显示或隐藏搜索框
	 *
	 * @param show 是否显示，不传则切换
	 */
	toggleSearch(show?: boolean): void {
		const visible = show ?? !this.searchWrapEl.isShown();
		this.searchWrapEl.toggle(visible);
		if (visible) {
			this.searchInputEl.focus();
			this.searchInputEl.select();
		} else {
			// 收起时清空搜索并回到树
			this.scheduleSearch.cancel();
			this.searchInputEl.value = "";
			this.setSearchQuery("");
			this.scrollEl.focus({ preventScroll: true });
		}
		this.updateHeaderState();
	}

	/**
	 * 应用搜索文本
	 *
	 * @param value 搜索文本
	 */
	private setSearchQuery(value: string): void {
		const query = value.trim();
		if (query === this.searchQuery) {
			return;
		}
		const wasSearching = this.searchQuery.length > 0;
		// 进入搜索时记住滚动位置，退出时恢复
		if (!wasSearching && query) {
			this.preSearchScrollTop = this.scrollEl.scrollTop;
		}
		this.searchQuery = query;
		this.searchCollapsed.clear();
		this.searchOpened.clear();
		this.renderTree();
		if (query) {
			this.scrollEl.scrollTop = 0;
		} else if (wasSearching) {
			this.scrollEl.scrollTop = this.preSearchScrollTop ?? 0;
			this.preSearchScrollTop = null;
		}
	}

	/**
	 * 弹出排序菜单
	 *
	 * @param evt 鼠标事件
	 */
	private showSortMenu(evt: MouseEvent): void {
		const settings = this.plugin.settings;
		const menu = new Menu();
		for (const order of Object.values(SortOrder)) {
			menu.addItem((item) =>
				item
					.setTitle(SORT_LABELS[order])
					.setChecked(settings.sortOrder === order)
					.onClick(async () => {
						settings.sortOrder = order;
						await this.plugin.saveSettings();
					}),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("文件夹在前（按名称排序时）")
				.setChecked(settings.foldersFirst)
				.onClick(async () => {
					settings.foldersFirst = !settings.foldersFirst;
					await this.plugin.saveSettings();
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 弹出自动定位模式菜单
	 *
	 * @param evt 鼠标事件
	 */
	private showAutoRevealMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const mode of Object.values(AutoRevealMode)) {
			menu.addItem((item) =>
				item
					.setTitle(AUTO_REVEAL_LABELS[mode])
					.setChecked(this.plugin.settings.autoRevealMode === mode)
					.onClick(() => void this.plugin.setAutoRevealMode(mode)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/**
	 * 切换自动定位开关（关闭 ↔ 上次使用的模式）
	 */
	private async toggleAutoReveal(): Promise<void> {
		const settings = this.plugin.settings;
		const next = settings.autoRevealMode === AutoRevealMode.Off ? settings.lastAutoRevealMode : AutoRevealMode.Off;
		await this.plugin.setAutoRevealMode(next);
	}

	// endregion

	// region 渲染

	/**
	 * 配置变化后刷新
	 */
	onSettingsChanged(): void {
		this.model.setSettings(this.plugin.settings);
		this.updateHeaderState();
		this.renderTree();
	}

	/**
	 * 主题变化后刷新图标
	 */
	onCssChange(): void {
		// 稍后执行，等 Material Icon Theme 先更新自己的亮暗状态
		window.setTimeout(() => {
			this.icons.clearCache();
			this.renderTree();
		}, 100);
	}

	/**
	 * 整树重新渲染（保留滚动位置与选择状态）
	 */
	renderTree(): void {
		// 行内重命名期间推迟，避免输入框被销毁
		if (this.renamingPath) {
			this.pendingRender = true;
			return;
		}
		this.pendingRender = false;
		this.scheduleRender.cancel();
		const settings = this.plugin.settings;
		this.model.setSettings(settings);
		this.model.build(this.searchQuery);
		this.icons.begin(settings.iconSource);

		const top = this.scrollEl.scrollTop;
		const left = this.scrollEl.scrollLeft;

		// region 容器样式
		this.scrollEl.toggleClass("vft-name-wrap", settings.nameDisplay === NameDisplayMode.Wrap);
		this.scrollEl.toggleClass("vft-name-ellipsis", settings.nameDisplay === NameDisplayMode.Ellipsis);
		this.scrollEl.toggleClass("vft-name-scroll", settings.nameDisplay === NameDisplayMode.Scroll);
		this.scrollEl.toggleClass("vft-show-guides", settings.showIndentGuides);
		this.scrollEl.toggleClass("vft-no-icons", settings.iconSource === IconSource.None);
		this.scrollEl.style.setProperty("--vft-indent", `${settings.indentWidth}px`);
		// endregion

		this.treeEl.empty();
		this.rows.clear();
		const root = this.app.vault.getRoot();
		if (settings.showRoot) {
			this.renderItem(root, this.treeEl, 0);
		} else {
			this.renderChildren(root, this.treeEl, 0);
		}
		// 搜索无结果提示
		if (this.model.isSearching() && this.rows.size === 0) {
			this.treeEl.createDiv({ cls: "vft-empty", text: "没有匹配的文件" });
		}

		this.scrollEl.scrollTop = top;
		this.scrollEl.scrollLeft = left;
		this.refreshStateClasses();
		this.updateCollapseButton();

		// 当前文件被重命名或移动后重新定位
		if (this.revealAfterRender) {
			this.revealAfterRender = false;
			this.autoReveal(true);
		}
	}

	/**
	 * 渲染文件夹的可见子项
	 *
	 * @param folder 文件夹
	 * @param parentEl 子项容器
	 * @param depth 子项缩进层级
	 */
	private renderChildren(folder: TFolder, parentEl: HTMLElement, depth: number): void {
		for (const child of this.model.getChildren(folder)) {
			this.renderItem(child, parentEl, depth);
		}
	}

	/**
	 * 渲染单个文件或文件夹
	 *
	 * @param item 文件或文件夹
	 * @param parentEl 父容器
	 * @param depth 缩进层级
	 */
	private renderItem(item: TAbstractFile, parentEl: HTMLElement, depth: number): void {
		const settings = this.plugin.settings;
		const isFolder = item instanceof TFolder;
		// 紧凑文件夹：把只有一个子文件夹的链合并成一行
		const chain = isFolder ? (item.isRoot() ? [item] : this.model.getCompactChain(item)) : [item];
		const tail = chain[chain.length - 1];
		const expanded = isFolder && this.isExpanded(tail.path);

		const itemEl = parentEl.createDiv({ cls: `vft-item ${isFolder ? "vft-folder" : "vft-file"}` });
		const selfEl = itemEl.createDiv({ cls: "vft-row" });
		selfEl.dataset.path = tail.path;
		selfEl.style.setProperty("--vft-depth", String(depth));

		// region 箭头、图标、名称、数量
		const chevronEl = selfEl.createDiv({ cls: "vft-chevron" });
		if (isFolder) {
			setIcon(chevronEl, "chevron-right");
			chevronEl.toggleClass("is-collapsed", !expanded);
		}
		let iconEl: HTMLElement | null = null;
		if (settings.iconSource !== IconSource.None) {
			iconEl = selfEl.createDiv({ cls: "vft-icon" });
			this.icons.render(iconEl, tail, !expanded, settings.iconSource);
		}
		const labelEl = selfEl.createDiv({ cls: "vft-label" });
		const label = isFolder
			? chain.map((f) => ((f as TFolder).isRoot() ? this.app.vault.getName() : f.name)).join(" / ")
			: this.model.getDisplayName(item);
		this.setLabel(labelEl, label);
		labelEl.dataset.fullName = isFolder ? label : item.name;
		if (isFolder && settings.showFileCount) {
			selfEl.createDiv({ cls: "vft-count", text: String(this.model.getFileCount(tail.path)) });
		}
		// endregion

		const ref: RowRef = {
			item: tail,
			head: item,
			itemEl,
			selfEl,
			chevronEl,
			iconEl,
			labelEl,
			childrenEl: null,
			depth,
		};
		// 紧凑链上的每个路径都映射到这一行，便于定位
		for (const f of chain) {
			this.rows.set(f.path, ref);
		}

		// 文件夹子项容器：只有展开时才渲染子项
		if (isFolder) {
			const childrenEl = itemEl.createDiv({ cls: "vft-children" });
			childrenEl.style.setProperty("--vft-depth", String(depth));
			ref.childrenEl = childrenEl;
			if (expanded) {
				this.renderChildren(tail as TFolder, childrenEl, depth + 1);
			} else {
				childrenEl.hide();
			}
		}

		this.registerRowDrag(ref);
	}

	/**
	 * 设置名称文本，搜索时高亮命中的关键词
	 *
	 * @param el 名称元素
	 * @param text 展示文本
	 */
	private setLabel(el: HTMLElement, text: string): void {
		el.empty();
		const terms = this.model.getSearchTerms();
		if (terms.length === 0) {
			el.setText(text);
			return;
		}
		// 标记命中的字符位置
		const settings = this.plugin.settings;
		const target = settings.searchCaseSensitive ? text : text.toLowerCase();
		const hit = new Array<boolean>(text.length).fill(false);
		for (const term of terms) {
			// 按路径搜索时关键词可能包含 /，只高亮名称中能找到的部分
			const needle = settings.searchScope === SearchScope.Path ? term.split("/").pop() ?? "" : term;
			if (!needle) {
				continue;
			}
			let idx = target.indexOf(needle);
			while (idx >= 0) {
				hit.fill(true, idx, idx + needle.length);
				idx = target.indexOf(needle, idx + needle.length);
			}
		}
		// 按命中状态切分文本片段
		let start = 0;
		for (let i = 1; i <= text.length; i++) {
			if (i === text.length || hit[i] !== hit[start]) {
				const part = text.slice(start, i);
				if (hit[start]) {
					el.createSpan({ cls: "vft-match", text: part });
				} else {
					el.appendText(part);
				}
				start = i;
			}
		}
	}

	/**
	 * 刷新高亮、焦点、多选样式
	 */
	private refreshStateClasses(): void {
		this.treeEl.querySelectorAll(".vft-row.is-active, .vft-row.has-focus, .vft-row.is-selected").forEach((el) => {
			el.removeClass("is-active", "has-focus", "is-selected");
		});
		if (this.activePath) {
			this.rows.get(this.activePath)?.selfEl.addClass("is-active");
		}
		if (this.focusedPath) {
			this.rows.get(this.focusedPath)?.selfEl.addClass("has-focus");
		}
		for (const path of this.selected) {
			this.rows.get(path)?.selfEl.addClass("is-selected");
		}
	}

	/**
	 * 获取当前渲染出的所有行（按显示顺序）
	 *
	 * @returns 行元素列表
	 */
	private getRowEls(): HTMLElement[] {
		return Array.from(this.treeEl.querySelectorAll<HTMLElement>(".vft-row"));
	}

	// endregion

	// region 展开与折叠

	/**
	 * 文件夹当前是否展开
	 *
	 * @param path 文件夹路径
	 * @returns 展开返回 true
	 */
	private isExpanded(path: string): boolean {
		if (path === "/") {
			return !this.rootCollapsed;
		}
		// 搜索时：手动折叠/展开优先，其次包含命中项的文件夹默认展开，最后沿用搜索前的展开状态
		if (this.model.isSearching()) {
			if (this.searchCollapsed.has(path)) {
				return false;
			}
			return this.searchOpened.has(path) || this.model.isSearchExpanded(path) || this.expanded.has(path);
		}
		return this.expanded.has(path);
	}

	/**
	 * 记录文件夹展开状态
	 *
	 * @param path 文件夹路径
	 * @param open 是否展开
	 */
	private setExpandedState(path: string, open: boolean): void {
		if (path === "/") {
			this.rootCollapsed = !open;
			return;
		}
		// 搜索时只记录在搜索专用集合中，退出搜索后恢复原展开状态
		if (this.model.isSearching()) {
			if (open) {
				this.searchCollapsed.delete(path);
				this.searchOpened.add(path);
			} else {
				this.searchOpened.delete(path);
				this.searchCollapsed.add(path);
			}
			return;
		}
		if (open) {
			this.expanded.add(path);
		} else {
			this.expanded.delete(path);
		}
	}

	/**
	 * 展开或折叠文件夹（只重绘该文件夹的子项）
	 *
	 * @param path 文件夹路径（紧凑链上任一路径均可）
	 * @param force 指定展开或折叠，不传则切换
	 */
	toggleFolder(path: string, force?: boolean): void {
		const ref = this.rows.get(path);
		if (!ref || !(ref.item instanceof TFolder) || !ref.childrenEl) {
			return;
		}
		const tailPath = ref.item.path;
		const current = this.isExpanded(tailPath);
		const next = force ?? !current;
		if (next === current) {
			return;
		}
		this.setExpandedState(tailPath, next);
		ref.chevronEl.toggleClass("is-collapsed", !next);
		// 移除旧子项的行引用
		const prefix = tailPath === "/" ? "" : `${tailPath}/`;
		for (const key of Array.from(this.rows.keys())) {
			if (key !== tailPath && key.startsWith(prefix) && this.rows.get(key) !== ref) {
				this.rows.delete(key);
			}
		}
		ref.childrenEl.empty();
		if (next) {
			this.renderChildren(ref.item, ref.childrenEl, ref.depth + 1);
			ref.childrenEl.show();
		} else {
			ref.childrenEl.hide();
		}
		// 文件夹图标区分展开与折叠
		if (ref.iconEl) {
			this.icons.render(ref.iconEl, ref.item, !next, this.plugin.settings.iconSource);
		}
		this.refreshStateClasses();
		this.updateCollapseButton();
		this.saveState();
	}

	/**
	 * 当前是否有展开的文件夹（以界面上渲染出的行为准，根节点不算）
	 *
	 * @returns 有展开的文件夹返回 true
	 */
	private hasExpandedFolders(): boolean {
		for (const ref of this.rows.values()) {
			if (ref.item instanceof TFolder && !ref.item.isRoot() && this.isExpanded(ref.item.path)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 按当前状态刷新折叠/展开按钮的图标与提示
	 */
	private updateCollapseButton(): void {
		const expanded = this.hasExpandedFolders();
		setIcon(this.collapseButtonEl, expanded ? "chevrons-down-up" : "chevrons-up-down");
		this.collapseButtonEl.setAttr("aria-label", expanded ? "全部折叠" : "全部展开");
	}

	/**
	 * 全部折叠/展开切换：有展开的文件夹时全部折叠，否则全部展开
	 */
	toggleCollapseAll(): void {
		if (this.hasExpandedFolders()) {
			this.collapseAll();
		} else {
			this.expandAll();
		}
	}

	/**
	 * 全部折叠（搜索时只作用于搜索结果）
	 */
	collapseAll(): void {
		this.rootCollapsed = false;
		if (this.model.isSearching()) {
			// 搜索时只折叠搜索结果，不改动搜索前的展开状态
			this.searchOpened.clear();
			this.model.getVisibleFolderPaths().forEach((p) => this.searchCollapsed.add(p));
		} else {
			this.expanded.clear();
		}
		this.renderTree();
		this.scrollEl.scrollTop = 0;
		this.saveState();
	}

	/**
	 * 递归展开所有可见文件夹（搜索时只作用于搜索结果，保持当前滚动位置）
	 */
	expandAll(): void {
		this.rootCollapsed = false;
		// 以最新的过滤结果为准
		this.model.build(this.searchQuery);
		const folders = this.model.getVisibleFolderPaths();
		if (this.model.isSearching()) {
			this.searchCollapsed.clear();
			folders.forEach((p) => this.searchOpened.add(p));
		} else {
			folders.forEach((p) => this.expanded.add(p));
		}
		this.renderTree();
		this.saveState();
	}

	// endregion

	// region 当前文件定位

	/**
	 * 当前文件变化（由插件在切换标签页、打开文件时调用）
	 *
	 * @param file 当前文件
	 */
	onActiveFileChange(file: TFile): void {
		// 同一个文件（如焦点在编辑器与侧边栏间切换）不重复定位
		if (file.path === this.activePath) {
			return;
		}
		this.activePath = file.path;
		this.refreshStateClasses();
		// 树内点击打开的文件：行本来就在眼前，只高亮
		if (this.openingFromTreePath === file.path) {
			this.openingFromTreePath = null;
			return;
		}
		this.autoReveal(true);
	}

	/**
	 * 按自动定位配置定位当前文件
	 *
	 * @param guard 是否遵守手动滚动保护时间
	 */
	private autoReveal(guard: boolean): void {
		const settings = this.plugin.settings;
		const mode = settings.autoRevealMode;
		const path = this.activePath;
		if (!path || mode === AutoRevealMode.Off || isUnderFolders(path, settings.revealExcludedFolders)) {
			this.pendingReveal = false;
			return;
		}
		// 视图不可见时推迟到重新显示
		if (!this.containerEl.isShown()) {
			this.pendingReveal = true;
			return;
		}
		this.pendingReveal = false;
		this.revealPath(path, {
			expand: mode !== AutoRevealMode.HighlightOnly,
			scroll: mode === AutoRevealMode.ExpandAndScroll,
			collapseOthers: settings.collapseOthersOnReveal,
			guard,
		});
	}

	/**
	 * 手动定位当前文件（工具栏按钮、命令）
	 */
	revealActiveFile(): void {
		const file = this.plugin.currentFile ?? this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("当前没有打开的文件");
			return;
		}
		this.revealFile(file);
	}

	/**
	 * 定位并聚焦指定文件（手动触发，总是展开并滚动）
	 *
	 * @param item 文件或文件夹
	 */
	revealFile(item: TAbstractFile): void {
		this.model.build(this.searchQuery);
		// 被过滤或不在搜索结果中时给出提示
		if (!this.model.isVisible(item.path)) {
			new Notice(this.model.isSearching() ? "该文件不在当前搜索结果中" : "该文件已被过滤规则隐藏");
			return;
		}
		const ok = this.revealPath(item.path, {
			expand: true,
			scroll: true,
			collapseOthers: this.plugin.settings.collapseOthersOnReveal,
			guard: false,
		});
		if (ok) {
			this.setFocus(item.path, false);
			this.scrollEl.focus({ preventScroll: true });
		}
	}

	/**
	 * 定位到指定路径
	 *
	 * @param path 文件路径
	 * @param options 定位参数
	 * @returns 成功定位到行返回 true
	 */
	private revealPath(path: string, options: RevealOptions): boolean {
		// 第一次可能还没渲染过模型
		if (this.rows.size === 0) {
			this.renderTree();
		}
		if (!this.model.isVisible(path)) {
			return false;
		}
		// region 展开上级
		if (options.expand) {
			const ancestors = getAncestorPaths(path);
			let needRender = this.plugin.settings.showRoot && this.rootCollapsed;
			this.rootCollapsed = false;
			if (options.collapseOthers) {
				// 只保留当前文件的上级处于展开状态
				const keep = new Set(ancestors);
				needRender = needRender || this.expanded.size !== keep.size || ancestors.some((a) => !this.expanded.has(a));
				this.expanded = keep;
				// 搜索时还要清除这些上级在搜索中的手动折叠
				if (this.model.isSearching()) {
					ancestors.forEach((a) => this.setExpandedState(a, true));
				}
			} else {
				for (const ancestor of ancestors) {
					if (!this.isExpanded(ancestor)) {
						this.setExpandedState(ancestor, true);
						needRender = true;
					}
				}
			}
			if (needRender) {
				this.renderTree();
			}
		}
		// endregion

		const ref = this.rows.get(path);
		if (!ref) {
			return false;
		}
		this.refreshStateClasses();
		// region 滚动
		if (options.scroll) {
			const guardMs = this.plugin.settings.scrollGuardMs;
			const recentlyScrolled = options.guard && guardMs > 0 && Date.now() - this.lastUserScrollAt < guardMs;
			if (!recentlyScrolled) {
				this.scrollRowIntoView(ref, this.plugin.settings.scrollAlign);
			}
		}
		// endregion
		this.saveState();
		return true;
	}

	/**
	 * 把行滚动到可见区域（已完整可见时不动）
	 *
	 * @param ref 行引用
	 * @param align 对齐方式
	 */
	private scrollRowIntoView(ref: RowRef, align: ScrollAlign): void {
		const sc = this.scrollEl;
		const scRect = sc.getBoundingClientRect();
		const rowRect = ref.selfEl.getBoundingClientRect();
		const rowTop = rowRect.top - scRect.top + sc.scrollTop;
		const rowHeight = rowRect.height;
		const viewHeight = sc.clientHeight;
		const padding = 4;
		// region 纵向
		const fullyVisible = rowTop >= sc.scrollTop && rowTop + rowHeight <= sc.scrollTop + viewHeight;
		if (!fullyVisible) {
			if (align === ScrollAlign.Center) {
				sc.scrollTop = rowTop - (viewHeight - rowHeight) / 2;
			} else if (rowTop < sc.scrollTop) {
				sc.scrollTop = rowTop - padding;
			} else {
				sc.scrollTop = rowTop + rowHeight - viewHeight + padding;
			}
		}
		// endregion
		// region 横向（仅横向滚动模式）：保证名称开头可见
		if (this.plugin.settings.nameDisplay === NameDisplayMode.Scroll) {
			const labelLeft = ref.labelEl.getBoundingClientRect().left - scRect.left + sc.scrollLeft;
			if (labelLeft < sc.scrollLeft || labelLeft > sc.scrollLeft + sc.clientWidth - 40) {
				sc.scrollLeft = Math.max(0, labelLeft - 48);
			}
		}
		// endregion
	}

	// endregion

	// region 鼠标与键盘交互

	/**
	 * 注册树容器上的鼠标、键盘、滚动事件（事件委托）
	 */
	private registerTreeEvents(): void {
		this.registerDomEvent(this.treeEl, "click", (evt) => this.onClick(evt));
		this.registerDomEvent(this.treeEl, "dblclick", (evt) => this.onDoubleClick(evt));
		this.registerDomEvent(this.treeEl, "auxclick", (evt) => this.onAuxClick(evt));
		this.registerDomEvent(this.scrollEl, "contextmenu", (evt) => this.onContextMenu(evt));
		this.registerDomEvent(this.scrollEl, "keydown", (evt) => this.onKeyDown(evt));
		this.registerDomEvent(this.treeEl, "mouseover", (evt) => this.onMouseOver(evt));
		// region 手动滚动检测（用于滚动保护）
		const markUserScroll = (): void => {
			this.lastUserScrollAt = Date.now();
		};
		this.registerDomEvent(this.scrollEl, "wheel", markUserScroll, { passive: true });
		this.registerDomEvent(this.scrollEl, "touchmove", markUserScroll, { passive: true });
		this.registerDomEvent(this.scrollEl, "mousedown", (evt) => {
			// 点在滚动容器本身上即拖动滚动条
			if (evt.target === this.scrollEl) {
				markUserScroll();
			}
		});
		this.registerDomEvent(this.scrollEl, "scroll", () => this.saveState());
		// endregion
	}

	/**
	 * 根据事件目标找到行
	 *
	 * @param target 事件目标
	 * @returns 行引用，未命中返回 null
	 */
	private getRowFromTarget(target: EventTarget | null): RowRef | null {
		if (!(target instanceof HTMLElement)) {
			return null;
		}
		const rowEl = target.closest<HTMLElement>(".vft-row");
		const path = rowEl?.dataset.path;
		return path ? this.rows.get(path) ?? null : null;
	}

	/**
	 * 单击：选择、展开折叠、打开文件
	 *
	 * @param evt 鼠标事件
	 */
	private onClick(evt: MouseEvent): void {
		if (evt.button !== 0) {
			return;
		}
		const ref = this.getRowFromTarget(evt.target);
		if (!ref) {
			this.clearSelection();
			return;
		}
		const path = ref.item.path;
		if (path === this.renamingPath) {
			return;
		}
		const isMod = Keymap.isModEvent(evt) !== false;
		// region 多选：Alt 点击切换选中，Shift 点击连续选中（与自带文件列表一致）
		if (evt.altKey && !evt.shiftKey && !isMod) {
			this.toggleSelected(path);
			return;
		}
		if (evt.shiftKey && !isMod) {
			this.selectRange(this.anchorPath ?? this.focusedPath ?? path, path);
			return;
		}
		// endregion
		this.clearSelection();
		this.setFocus(path, false);
		this.anchorPath = path;
		if (ref.item instanceof TFolder) {
			this.toggleFolder(path);
			this.scrollEl.focus({ preventScroll: true });
			return;
		}
		// 单击打开模式，或按住 Cmd/Ctrl 时打开
		if (this.plugin.settings.clickOpenMode === ClickOpenMode.Single || isMod) {
			void this.openFromTree(ref.item as TFile, evt);
		} else {
			this.scrollEl.focus({ preventScroll: true });
		}
	}

	/**
	 * 双击：双击打开模式下打开文件
	 *
	 * @param evt 鼠标事件
	 */
	private onDoubleClick(evt: MouseEvent): void {
		const ref = this.getRowFromTarget(evt.target);
		if (!ref || !(ref.item instanceof TFile) || ref.item.path === this.renamingPath) {
			return;
		}
		if (this.plugin.settings.clickOpenMode === ClickOpenMode.Double) {
			void this.openFromTree(ref.item, evt);
		}
	}

	/**
	 * 中键：在新标签页打开
	 *
	 * @param evt 鼠标事件
	 */
	private onAuxClick(evt: MouseEvent): void {
		if (evt.button !== 1) {
			return;
		}
		const ref = this.getRowFromTarget(evt.target);
		if (ref && ref.item instanceof TFile) {
			void this.openFromTree(ref.item, evt);
		}
	}

	/**
	 * 省略号模式下，名称被截断时悬停显示全名
	 *
	 * @param evt 鼠标事件
	 */
	private onMouseOver(evt: MouseEvent): void {
		if (this.plugin.settings.nameDisplay !== NameDisplayMode.Ellipsis || !(evt.target instanceof HTMLElement)) {
			return;
		}
		const labelEl = evt.target.closest<HTMLElement>(".vft-label");
		if (!labelEl) {
			return;
		}
		// 只有被截断时才显示提示
		if (labelEl.scrollWidth > labelEl.clientWidth) {
			labelEl.setAttr("title", labelEl.dataset.fullName ?? labelEl.getText());
		} else {
			labelEl.removeAttribute("title");
		}
	}

	/**
	 * 从树内打开文件（标记来源，避免随后的文件切换再触发定位）
	 *
	 * @param file 文件
	 * @param evt 触发事件
	 */
	private async openFromTree(file: TFile, evt: MouseEvent | KeyboardEvent | null): Promise<void> {
		this.openingFromTreePath = file.path;
		// 文件本来就是当前文件时不会触发切换事件，定时清理标记
		if (this.openingTimer !== null) {
			window.clearTimeout(this.openingTimer);
		}
		this.openingTimer = window.setTimeout(() => {
			this.openingFromTreePath = null;
			this.openingTimer = null;
		}, 1000);
		const opened = await this.actions.openFile(file, evt);
		if (!opened) {
			this.openingFromTreePath = null;
		}
	}

	/**
	 * 键盘导航
	 *
	 * @param evt 键盘事件
	 */
	private onKeyDown(evt: KeyboardEvent): void {
		// 重命名输入框、搜索框里的按键不处理
		if (this.renamingPath || evt.target instanceof HTMLInputElement) {
			return;
		}
		const rowEls = this.getRowEls();
		const focusedRef = this.focusedPath ? this.rows.get(this.focusedPath) ?? null : null;
		const index = focusedRef ? rowEls.indexOf(focusedRef.selfEl) : -1;
		const focusAt = (i: number): void => {
			const el = rowEls[Math.max(0, Math.min(rowEls.length - 1, i))];
			if (el?.dataset.path) {
				this.clearSelection();
				this.setFocus(el.dataset.path, true);
			}
		};

		switch (evt.key) {
			case "ArrowDown":
				focusAt(index + 1);
				break;
			case "ArrowUp":
				focusAt(index < 0 ? 0 : index - 1);
				break;
			case "Home":
				focusAt(0);
				break;
			case "End":
				focusAt(rowEls.length - 1);
				break;
			case "ArrowRight":
				// 折叠的文件夹先展开，已展开则进入第一个子项
				if (focusedRef && focusedRef.item instanceof TFolder) {
					if (this.isExpanded(focusedRef.item.path)) {
						focusAt(index + 1);
					} else {
						this.toggleFolder(focusedRef.item.path, true);
					}
				}
				break;
			case "ArrowLeft":
				// 展开的文件夹先折叠，否则跳到上级文件夹
				if (focusedRef) {
					if (focusedRef.item instanceof TFolder && this.isExpanded(focusedRef.item.path)) {
						this.toggleFolder(focusedRef.item.path, false);
					} else {
						const parent = focusedRef.head.parent;
						const parentRef = parent ? this.rows.get(parent.path) : null;
						if (parentRef) {
							this.setFocus(parentRef.item.path, true);
						}
					}
				}
				break;
			case "Enter":
				if (focusedRef) {
					if (focusedRef.item instanceof TFolder) {
						this.toggleFolder(focusedRef.item.path);
					} else {
						void this.openFromTree(focusedRef.item as TFile, evt);
					}
				}
				break;
			case "F2":
				if (focusedRef) {
					this.startRename(focusedRef.item.path);
				}
				break;
			case "Delete":
				void this.deleteSelection();
				break;
			case "Backspace":
				// macOS 习惯：Cmd+Backspace 删除
				if (!Keymap.isModEvent(evt)) {
					return;
				}
				void this.deleteSelection();
				break;
			case "Escape":
				if (this.selected.size > 0) {
					this.clearSelection();
				} else if (this.searchQuery) {
					this.toggleSearch(false);
				} else {
					return;
				}
				break;
			default:
				return;
		}
		evt.preventDefault();
		evt.stopPropagation();
	}

	/**
	 * 设置键盘焦点行
	 *
	 * @param path 路径
	 * @param scroll 是否滚动到可见
	 */
	private setFocus(path: string, scroll: boolean): void {
		this.focusedPath = path;
		this.refreshStateClasses();
		const ref = this.rows.get(path);
		if (scroll && ref) {
			this.scrollRowIntoView(ref, ScrollAlign.Nearest);
		}
	}

	/**
	 * 切换某行的选中状态
	 *
	 * @param path 路径
	 */
	private toggleSelected(path: string): void {
		// 第一次 Alt 点击时把当前焦点行也纳入选择
		if (this.selected.size === 0 && this.focusedPath && this.focusedPath !== path) {
			this.selected.add(this.focusedPath);
		}
		if (this.selected.has(path)) {
			this.selected.delete(path);
		} else {
			this.selected.add(path);
		}
		this.focusedPath = path;
		this.anchorPath = path;
		this.refreshStateClasses();
	}

	/**
	 * 连续选择两行之间的所有行
	 *
	 * @param from 起点路径
	 * @param to 终点路径
	 */
	private selectRange(from: string, to: string): void {
		const rowEls = this.getRowEls();
		const a = rowEls.indexOf(this.rows.get(from)?.selfEl as HTMLElement);
		const b = rowEls.indexOf(this.rows.get(to)?.selfEl as HTMLElement);
		this.selected.clear();
		if (a < 0 || b < 0) {
			this.selected.add(to);
		} else {
			for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
				const p = rowEls[i].dataset.path;
				if (p) {
					this.selected.add(p);
				}
			}
		}
		this.focusedPath = to;
		this.refreshStateClasses();
	}

	/**
	 * 清空多选
	 */
	private clearSelection(): void {
		if (this.selected.size === 0) {
			return;
		}
		this.selected.clear();
		this.refreshStateClasses();
	}

	/**
	 * 获取选中项；没有多选时取焦点行
	 *
	 * @returns 文件或文件夹列表
	 */
	private getSelectedItems(): TAbstractFile[] {
		const paths = this.selected.size > 0 ? Array.from(this.selected) : this.focusedPath ? [this.focusedPath] : [];
		return paths
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter((f): f is TAbstractFile => f !== null && !(f instanceof TFolder && f.isRoot()));
	}

	/**
	 * 删除选中项
	 */
	private async deleteSelection(): Promise<void> {
		const items = this.getSelectedItems();
		if (items.length > 0) {
			await this.actions.deleteItems(items);
		}
	}

	// endregion

	// region 右键菜单

	/**
	 * 右键菜单：单项菜单与多选菜单，并触发 file-menu 让其他插件追加菜单项
	 *
	 * @param evt 鼠标事件
	 */
	private onContextMenu(evt: MouseEvent): void {
		if (this.renamingPath) {
			return;
		}
		evt.preventDefault();
		const menu = new Menu();
		addFileMenuSections(menu);
		const ref = this.getRowFromTarget(evt.target);

		// region 空白处：针对根目录
		if (!ref) {
			const root = this.app.vault.getRoot();
			this.addFolderCreateItems(menu, root);
			this.app.workspace.trigger("file-menu", menu, root, FILE_MENU_SOURCE, this.leaf);
			menu.showAtMouseEvent(evt);
			return;
		}
		// endregion

		const item = ref.item;
		// region 多选
		if (this.selected.size > 1 && this.selected.has(item.path)) {
			const items = this.getSelectedItems();
			menu.addItem((mi) =>
				mi
					.setSection("danger")
					.setTitle(`删除 ${items.length} 项`)
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => void this.actions.deleteItems(items)),
			);
			this.app.workspace.trigger("files-menu", menu, items, FILE_MENU_SOURCE, this.leaf);
			this.showMenuOnRow(menu, evt, ref);
			return;
		}
		// endregion

		this.clearSelection();
		this.setFocus(item.path, false);
		const isRoot = item instanceof TFolder && item.isRoot();

		// region 单项
		if (item instanceof TFolder) {
			this.addFolderCreateItems(menu, item);
		} else if (item instanceof TFile && isExtensionSupported(this.app, item.extension)) {
			menu.addItem((mi) =>
				mi
					.setSection("open")
					.setTitle("在新标签页中打开")
					.setIcon("file-plus")
					.onClick(() => void this.app.workspace.getLeaf("tab").openFile(item)),
			);
			menu.addItem((mi) =>
				mi
					.setSection("open")
					.setTitle("在右侧打开")
					.setIcon("separator-vertical")
					.onClick(() => void this.app.workspace.getLeaf("split").openFile(item)),
			);
		}
		if (!isRoot) {
			menu.addItem((mi) =>
				mi
					.setSection("action")
					.setTitle("创建副本")
					.setIcon("files")
					.onClick(async () => {
						const copy = await this.actions.duplicate(item);
						if (copy) {
							this.renderTree();
							this.startRename(copy.path);
						}
					}),
			);
			menu.addItem((mi) =>
				mi
					.setSection("danger")
					.setTitle("重命名")
					.setIcon("pencil")
					.onClick(() => this.startRename(item.path)),
			);
			menu.addItem((mi) =>
				mi
					.setSection("danger")
					.setTitle("删除")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => void this.actions.deleteItems([item])),
			);
		}
		// endregion

		// 让 Obsidian 与其他插件追加菜单项（书签、在访达中显示、复制路径等）
		this.app.workspace.trigger("file-menu", menu, item, FILE_MENU_SOURCE, this.leaf);
		this.showMenuOnRow(menu, evt, ref);
	}

	/**
	 * 添加“新建笔记”“新建文件夹”菜单项
	 *
	 * @param menu 菜单
	 * @param folder 目标文件夹
	 */
	private addFolderCreateItems(menu: Menu, folder: TFolder): void {
		menu.addItem((mi) =>
			mi
				.setSection("action-primary")
				.setTitle("新建笔记")
				.setIcon("edit")
				.onClick(() => void this.createNote(folder)),
		);
		menu.addItem((mi) =>
			mi
				.setSection("action-primary")
				.setTitle("新建文件夹")
				.setIcon("folder-plus")
				.onClick(() => void this.createFolder(folder)),
		);
	}

	/**
	 * 在行上弹出菜单，菜单打开期间高亮该行
	 *
	 * @param menu 菜单
	 * @param evt 鼠标事件
	 * @param ref 行引用
	 */
	private showMenuOnRow(menu: Menu, evt: MouseEvent, ref: RowRef): void {
		ref.selfEl.addClass("has-menu");
		menu.onHide(() => ref.selfEl.removeClass("has-menu"));
		menu.showAtMouseEvent(evt);
	}

	// endregion

	// region 新建与重命名

	/**
	 * 计算新建文件的目标文件夹：焦点行所在文件夹，没有焦点时按 Obsidian 新建位置配置
	 *
	 * @returns 目标文件夹
	 */
	private getContextFolder(): TFolder {
		const focused = this.focusedPath ? this.app.vault.getAbstractFileByPath(this.focusedPath) : null;
		if (focused instanceof TFolder) {
			return focused;
		}
		if (focused?.parent) {
			return focused.parent;
		}
		const active = this.app.workspace.getActiveFile();
		return this.app.fileManager.getNewFileParent(active?.path ?? "");
	}

	/**
	 * 新建笔记：创建后进入行内重命名，确认后打开
	 *
	 * @param folder 目标文件夹，不传则自动计算
	 */
	async createNote(folder?: TFolder): Promise<void> {
		const file = await this.actions.createNote(folder ?? this.getContextFolder());
		if (!file) {
			return;
		}
		this.prepareRowForEdit(file);
		this.startRename(file.path, (item) => {
			if (item instanceof TFile) {
				void this.openFromTree(item, null);
			}
		});
	}

	/**
	 * 新建文件夹：创建后进入行内重命名
	 *
	 * @param folder 父文件夹，不传则自动计算
	 */
	async createFolder(folder?: TFolder): Promise<void> {
		const created = await this.actions.createFolder(folder ?? this.getContextFolder());
		if (!created) {
			return;
		}
		this.prepareRowForEdit(created);
		this.startRename(created.path);
	}

	/**
	 * 新建项后立即渲染并展开到该行
	 *
	 * @param item 新建的文件或文件夹
	 */
	private prepareRowForEdit(item: TAbstractFile): void {
		for (const ancestor of getAncestorPaths(item.path)) {
			this.setExpandedState(ancestor, true);
		}
		this.rootCollapsed = false;
		this.renderTree();
		const ref = this.rows.get(item.path);
		if (ref) {
			this.setFocus(item.path, false);
			this.scrollRowIntoView(ref, ScrollAlign.Nearest);
		}
	}

	/**
	 * 行内重命名
	 *
	 * @param path 路径
	 * @param onDone 结束回调（无论确认还是取消）
	 */
	startRename(path: string, onDone?: (item: TAbstractFile) => void): void {
		const ref = this.rows.get(path);
		const item = ref?.item;
		// 根目录不能重命名；行不可见（被过滤）时直接结束
		if (!ref || !item || (item instanceof TFolder && item.isRoot()) || this.renamingPath) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file) {
				onDone?.(file);
			}
			return;
		}
		this.renamingPath = item.path;
		ref.selfEl.addClass("is-being-renamed");
		ref.selfEl.draggable = false;
		ref.labelEl.hide();

		// region 输入框
		const input = createEl("input", { cls: "vft-rename-input", type: "text" });
		input.value = item.name;
		ref.labelEl.insertAdjacentElement("afterend", input);
		input.focus();
		// 文件只选中主名，方便直接改名
		const dot = item.name.lastIndexOf(".");
		if (item instanceof TFile && dot > 0) {
			input.setSelectionRange(0, dot);
		} else {
			input.select();
		}
		// endregion

		let finished = false;
		const finish = async (commit: boolean): Promise<void> => {
			if (finished) {
				return;
			}
			finished = true;
			const value = input.value.trim();
			input.remove();
			ref.labelEl.show();
			ref.selfEl.removeClass("is-being-renamed");
			ref.selfEl.draggable = true;
			// 提交改名（失败时 actions 内部已提示）
			if (commit && value && value !== item.name) {
				await this.actions.rename(item, value);
			}
			this.renamingPath = null;
			this.renderTree();
			this.setFocus(item.path, false);
			this.scrollEl.focus({ preventScroll: true });
			onDone?.(item);
		};

		input.addEventListener("keydown", (evt) => {
			// 输入框内按键不冒泡到树和 Obsidian 快捷键
			evt.stopPropagation();
			if (evt.key === "Enter") {
				evt.preventDefault();
				void finish(true);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				void finish(false);
			}
		});
		input.addEventListener("blur", () => void finish(true));
		input.addEventListener("click", (evt) => evt.stopPropagation());
		input.addEventListener("dblclick", (evt) => evt.stopPropagation());
	}

	// endregion

	// region 拖拽

	/**
	 * 让行可拖拽：拖进编辑器插入链接、拖到其他文件夹移动
	 *
	 * @param ref 行引用
	 */
	private registerRowDrag(ref: RowRef): void {
		const item = ref.item;
		if (item instanceof TFolder && item.isRoot()) {
			return;
		}
		const dm = getDragManager(this.app);
		if (!dm) {
			// 降级：原生拖拽，只能拖进编辑器插入链接文本
			ref.selfEl.draggable = true;
			ref.selfEl.addEventListener("dragstart", (evt) => {
				if (item instanceof TFile) {
					evt.dataTransfer?.setData("text/plain", this.app.fileManager.generateMarkdownLink(item, ""));
				}
			});
			return;
		}
		dm.handleDrag(ref.selfEl, (evt): DragData | null => {
			if (this.renamingPath) {
				return null;
			}
			// 拖拽多选中的某一项时拖整个选择
			if (this.selected.size > 1 && this.selected.has(item.path)) {
				const items = this.getSelectedItems();
				const els = items.map((i) => this.rows.get(i.path)?.selfEl).filter((el): el is HTMLElement => !!el);
				dm.updateSource?.(els, "is-being-dragged");
				return dm.dragFiles(evt, items);
			}
			dm.updateSource?.([ref.selfEl], "is-being-dragged");
			return item instanceof TFile ? dm.dragFile(evt, item) : dm.dragFolder(evt, item as TFolder);
		});
	}

	/**
	 * 注册拖放目标：整个滚动容器统一处理，按鼠标位置计算目标文件夹
	 */
	private registerDropTarget(): void {
		const dm = getDragManager(this.app);
		if (!dm) {
			return;
		}
		dm.handleDrop(this.scrollEl, (evt, draggable, isOver) => this.onDrop(evt, draggable, isOver), true);
		// 离开容器时取消悬停展开
		this.registerDomEvent(this.scrollEl, "dragleave", (evt) => {
			if (!(evt.relatedTarget instanceof Node) || !this.scrollEl.contains(evt.relatedTarget)) {
				this.clearHoverExpand();
			}
		});
	}

	/**
	 * 拖放回调
	 *
	 * @param evt 拖拽事件
	 * @param draggable 拖拽数据（外部文件拖入时为 null）
	 * @param isOver true 表示悬停中，false 表示松手
	 * @returns 悬停提示与高亮信息；返回空表示不可放置
	 */
	private onDrop(evt: DragEvent, draggable: DragData | null, isOver: boolean): DropResult | undefined {
		const target = this.getDropTarget(evt.target);
		const targetName = target.folder.isRoot() ? this.app.vault.getName() : target.folder.name;

		// region 从系统拖入文件：复制到库中
		if (!draggable) {
			const dt = evt.dataTransfer;
			if (!dt || !Array.from(dt.types).includes("Files")) {
				return undefined;
			}
			if (!isOver) {
				this.clearHoverExpand();
				void this.actions.importExternalFiles(Array.from(dt.files), target.folder);
			} else {
				this.scheduleHoverExpand(target.folder);
			}
			return { action: `复制到“${targetName}”`, dropEffect: "copy", hoverEl: target.hoverEl, hoverClass: DRAG_OVER_CLASS };
		}
		// endregion

		// region 库内文件：移动
		let items: TAbstractFile[] = [];
		if (draggable.type === "files") {
			items = draggable.files ?? [];
		} else if ((draggable.type === "file" || draggable.type === "folder") && draggable.file) {
			items = [draggable.file];
		}
		const movable = items.filter((i) => this.actions.canMoveTo(i, target.folder));
		if (movable.length === 0) {
			this.clearHoverExpand();
			return undefined;
		}
		if (isOver) {
			this.scheduleHoverExpand(target.folder);
		} else {
			this.clearHoverExpand();
			void this.moveItems(movable, target.folder);
		}
		return { action: `移动到“${targetName}”`, dropEffect: "move", hoverEl: target.hoverEl, hoverClass: DRAG_OVER_CLASS };
		// endregion
	}

	/**
	 * 根据鼠标所在元素计算放置目标：文件夹行放进该文件夹，文件行放进其所在文件夹，空白处放到根目录
	 *
	 * @param target 事件目标
	 * @returns 目标文件夹与需要高亮的元素
	 */
	private getDropTarget(target: EventTarget | null): { folder: TFolder; hoverEl: HTMLElement } {
		const ref = this.getRowFromTarget(target);
		const root = this.app.vault.getRoot();
		if (ref) {
			const folder = ref.item instanceof TFolder ? ref.item : ref.head.parent ?? root;
			const folderRef = ref.item instanceof TFolder ? ref : this.rows.get(folder.path);
			// 根目录（未显示根节点时）高亮整个容器
			return { folder, hoverEl: folderRef && !folder.isRoot() ? folderRef.itemEl : this.scrollEl };
		}
		return { folder: root, hoverEl: this.scrollEl };
	}

	/**
	 * 拖拽悬停在折叠的文件夹上一段时间后自动展开
	 *
	 * @param folder 目标文件夹
	 */
	private scheduleHoverExpand(folder: TFolder): void {
		if (folder.isRoot() || this.isExpanded(folder.path)) {
			this.clearHoverExpand();
			return;
		}
		if (this.hoverExpandPath === folder.path) {
			return;
		}
		this.clearHoverExpand();
		this.hoverExpandPath = folder.path;
		this.hoverExpandTimer = window.setTimeout(() => {
			if (this.hoverExpandPath === folder.path) {
				this.toggleFolder(folder.path, true);
			}
			this.hoverExpandPath = null;
			this.hoverExpandTimer = null;
		}, HOVER_EXPAND_DELAY);
	}

	/**
	 * 取消悬停展开
	 */
	private clearHoverExpand(): void {
		if (this.hoverExpandTimer !== null) {
			window.clearTimeout(this.hoverExpandTimer);
		}
		this.hoverExpandTimer = null;
		this.hoverExpandPath = null;
	}

	/**
	 * 移动后展开目标文件夹并选中移动的项
	 *
	 * @param items 待移动项
	 * @param target 目标文件夹
	 */
	private async moveItems(items: TAbstractFile[], target: TFolder): Promise<void> {
		const moved = await this.actions.moveItems(items, target);
		if (moved.length === 0) {
			return;
		}
		if (!target.isRoot()) {
			this.setExpandedState(target.path, true);
		}
		this.selected.clear();
		if (moved.length > 1) {
			moved.forEach((m) => this.selected.add(m.path));
		}
		this.focusedPath = moved[0].path;
		this.renderTree();
	}

	// endregion

	// region 库事件与状态持久化

	/**
	 * 监听库文件变化
	 */
	private registerVaultEvents(): void {
		const vault = this.app.vault;
		this.registerEvent(vault.on("create", () => this.scheduleRender()));
		this.registerEvent(
			vault.on("delete", (file) => {
				this.removePath(file.path);
				this.scheduleRender();
			}),
		);
		this.registerEvent(
			vault.on("rename", (file, oldPath) => {
				this.remapPath(oldPath, file.path);
				this.scheduleRender();
			}),
		);
		// 按时间排序时修改文件会改变顺序
		this.registerEvent(
			vault.on("modify", () => {
				const order = this.plugin.settings.sortOrder;
				if (order !== SortOrder.NameAsc && order !== SortOrder.NameDesc) {
					this.scheduleRender();
				}
			}),
		);
	}

	/**
	 * 判断路径是否为某路径本身或其子孙
	 *
	 * @param path 待判断路径
	 * @param base 基准路径
	 * @returns 命中返回 true
	 */
	private static isSelfOrChild(path: string, base: string): boolean {
		return path === base || path.startsWith(`${base}/`);
	}

	/**
	 * 删除后清理相关状态
	 *
	 * @param path 被删除的路径
	 */
	private removePath(path: string): void {
		const hit = (p: string | null): boolean => p !== null && FileTreeView.isSelfOrChild(p, path);
		this.expanded = new Set(Array.from(this.expanded).filter((p) => !hit(p)));
		Array.from(this.selected).filter(hit).forEach((p) => this.selected.delete(p));
		if (hit(this.focusedPath)) {
			this.focusedPath = null;
		}
		if (hit(this.anchorPath)) {
			this.anchorPath = null;
		}
		if (hit(this.activePath)) {
			this.activePath = null;
		}
	}

	/**
	 * 重命名或移动后把相关状态映射到新路径
	 *
	 * @param oldPath 旧路径
	 * @param newPath 新路径
	 */
	private remapPath(oldPath: string, newPath: string): void {
		const map = (p: string): string => (FileTreeView.isSelfOrChild(p, oldPath) ? newPath + p.slice(oldPath.length) : p);
		this.expanded = new Set(Array.from(this.expanded).map(map));
		const selected = Array.from(this.selected).map(map);
		this.selected.clear();
		selected.forEach((p) => this.selected.add(p));
		if (this.focusedPath) {
			this.focusedPath = map(this.focusedPath);
		}
		if (this.anchorPath) {
			this.anchorPath = map(this.anchorPath);
		}
		// 当前文件被重命名或移动：渲染后重新定位
		if (this.activePath && FileTreeView.isSelfOrChild(this.activePath, oldPath)) {
			this.activePath = map(this.activePath);
			this.revealAfterRender = true;
		}
		this.saveState();
	}

	/**
	 * 保存展开状态与滚动位置（防抖写盘）
	 */
	private saveState(): void {
		const settings = this.plugin.settings;
		if (!settings.rememberState || !this.scrollEl) {
			return;
		}
		settings.expandedFolders = Array.from(this.expanded);
		// 搜索时的滚动位置不保存
		if (!this.searchQuery) {
			settings.scrollTop = this.scrollEl.scrollTop;
		}
		this.plugin.requestSaveState();
	}

	// endregion
}
