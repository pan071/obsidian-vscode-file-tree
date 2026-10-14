/**
 * 文件树插件公共类型、枚举与默认配置
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */

/** 文件树视图类型标识 */
export const VIEW_TYPE_FILE_TREE = "vscode-file-tree-view";

/** 本插件触发 file-menu 时使用的来源标识（与自带文件列表一致，便于其他插件追加菜单项） */
export const FILE_MENU_SOURCE = "file-explorer-context-menu";

/**
 * 扩展名过滤模式
 */
export enum FilterMode {
	/** 显示全部文件 */
	All = "all",
	/** 黑名单：隐藏列表中的扩展名 */
	Blacklist = "blacklist",
	/** 白名单：只显示列表中的扩展名 */
	Whitelist = "whitelist",
}

/**
 * 长文件名展示方式
 */
export enum NameDisplayMode {
	/** 自动换行，完整展示 */
	Wrap = "wrap",
	/** 省略号截断，悬停显示全名 */
	Ellipsis = "ellipsis",
	/** 单行完整展示，超出宽度时出现横向滚动条 */
	Scroll = "scroll",
}

/**
 * 扩展名显示方式
 */
export enum ExtensionDisplay {
	/** 全部显示 */
	ShowAll = "show-all",
	/** 只隐藏 .md */
	HideMarkdown = "hide-md",
	/** 全部隐藏 */
	HideAll = "hide-all",
}

/**
 * 文件排序方式
 */
export enum SortOrder {
	/** 名称 A → Z（自然排序） */
	NameAsc = "name-asc",
	/** 名称 Z → A（自然排序） */
	NameDesc = "name-desc",
	/** 修改时间，新 → 旧 */
	ModifiedDesc = "mtime-desc",
	/** 修改时间，旧 → 新 */
	ModifiedAsc = "mtime-asc",
	/** 创建时间，新 → 旧 */
	CreatedDesc = "ctime-desc",
	/** 创建时间，旧 → 新 */
	CreatedAsc = "ctime-asc",
}

/**
 * 自动显示当前文件模式
 */
export enum AutoRevealMode {
	/** 关闭 */
	Off = "off",
	/** 展开上级文件夹，并在不可见时滚动到该行 */
	ExpandAndScroll = "expand-scroll",
	/** 只展开上级文件夹，不滚动 */
	ExpandOnly = "expand",
	/** 只高亮，不展开、不滚动 */
	HighlightOnly = "highlight",
}

/**
 * 定位滚动时的对齐方式
 */
export enum ScrollAlign {
	/** 刚好可见 */
	Nearest = "nearest",
	/** 居中 */
	Center = "center",
}

/**
 * 文件打开触发方式
 */
export enum ClickOpenMode {
	/** 单击打开 */
	Single = "single",
	/** 双击打开（单击只选中） */
	Double = "double",
}

/**
 * 默认打开位置
 */
export enum OpenLocation {
	/** 当前标签页 */
	CurrentTab = "current",
	/** 新标签页 */
	NewTab = "tab",
}

/**
 * Obsidian 无法打开的文件的处理方式
 */
export enum UnsupportedFileAction {
	/** 用系统默认程序打开 */
	DefaultApp = "default-app",
	/** 在访达中显示 */
	ShowInFolder = "show-in-folder",
}

/**
 * 搜索匹配范围
 */
export enum SearchScope {
	/** 仅文件名 */
	Name = "name",
	/** 完整路径 */
	Path = "path",
}

/**
 * 图标来源
 */
export enum IconSource {
	/** 自动：已启用 Material Icon Theme 时使用其图标，否则使用内置图标 */
	Auto = "auto",
	/** 内置图标 */
	Builtin = "builtin",
	/** 不显示图标 */
	None = "none",
}

/**
 * 插件配置（含需要持久化的视图状态）
 */
export interface FileTreeSettings {
	// region 显示
	/** 长文件名展示方式 */
	nameDisplay: NameDisplayMode;
	/** 扩展名显示方式 */
	extensionDisplay: ExtensionDisplay;
	/** 是否显示根节点（库名） */
	showRoot: boolean;
	/** 文件夹是否显示文件数量 */
	showFileCount: boolean;
	/** 每级缩进宽度（px） */
	indentWidth: number;
	/** 是否显示缩进参考线 */
	showIndentGuides: boolean;
	/** 是否合并只有一个子文件夹的文件夹链 */
	compactFolders: boolean;
	/** 文件排序方式 */
	sortOrder: SortOrder;
	/** 按名称排序时文件夹是否排在前面 */
	foldersFirst: boolean;
	/** 图标来源 */
	iconSource: IconSource;
	// endregion

	// region 过滤
	/** 扩展名过滤模式 */
	filterMode: FilterMode;
	/** 过滤用的扩展名列表（小写、不带点，可包含多段如 excalidraw.md） */
	filterExtensions: string[];
	/** 隐藏的文件夹路径 */
	hiddenFolders: string[];
	/** 是否隐藏过滤后没有任何文件的文件夹 */
	hideEmptyFolders: boolean;
	// endregion

	// region 自动显示当前文件
	/** 自动显示当前文件模式 */
	autoRevealMode: AutoRevealMode;
	/** 工具栏开关从关闭切回开启时恢复的模式 */
	lastAutoRevealMode: AutoRevealMode;
	/** 定位滚动对齐方式 */
	scrollAlign: ScrollAlign;
	/** 手动滚动保护时间（毫秒），期间切换文件只高亮不滚动，0 表示关闭 */
	scrollGuardMs: number;
	/** 定位时是否折叠与当前文件无关的文件夹 */
	collapseOthersOnReveal: boolean;
	/** 不自动定位的文件夹路径 */
	revealExcludedFolders: string[];
	// endregion

	// region 打开行为
	/** 文件打开触发方式 */
	clickOpenMode: ClickOpenMode;
	/** 默认打开位置（按住 Cmd/Ctrl 时使用另一种） */
	openLocation: OpenLocation;
	/** Obsidian 无法打开的文件的处理方式 */
	unsupportedFileAction: UnsupportedFileAction;
	// endregion

	// region 搜索
	/** 搜索匹配范围 */
	searchScope: SearchScope;
	/** 搜索是否区分大小写 */
	searchCaseSensitive: boolean;
	// endregion

	// region 拖拽
	/** 拖拽移动前是否弹窗确认 */
	confirmBeforeMove: boolean;
	// endregion

	// region 其他
	/** 启动时自动打开视图 */
	openOnStartup: boolean;
	/** 是否记住展开状态与滚动位置 */
	rememberState: boolean;
	// endregion

	// region 持久化状态（不在设置页展示）
	/** 已展开的文件夹路径 */
	expandedFolders: string[];
	/** 上次的纵向滚动位置 */
	scrollTop: number;
	// endregion
}

/** 默认配置 */
export const DEFAULT_SETTINGS: FileTreeSettings = {
	nameDisplay: NameDisplayMode.Wrap,
	extensionDisplay: ExtensionDisplay.ShowAll,
	showRoot: false,
	showFileCount: false,
	indentWidth: 16,
	showIndentGuides: true,
	compactFolders: false,
	sortOrder: SortOrder.NameAsc,
	foldersFirst: true,
	iconSource: IconSource.Auto,

	filterMode: FilterMode.All,
	filterExtensions: [],
	hiddenFolders: [],
	hideEmptyFolders: false,

	autoRevealMode: AutoRevealMode.ExpandAndScroll,
	lastAutoRevealMode: AutoRevealMode.ExpandAndScroll,
	scrollAlign: ScrollAlign.Nearest,
	scrollGuardMs: 500,
	collapseOthersOnReveal: false,
	revealExcludedFolders: [],

	clickOpenMode: ClickOpenMode.Single,
	openLocation: OpenLocation.CurrentTab,
	unsupportedFileAction: UnsupportedFileAction.DefaultApp,

	searchScope: SearchScope.Name,
	searchCaseSensitive: false,

	confirmBeforeMove: true,

	openOnStartup: true,
	rememberState: true,

	expandedFolders: [],
	scrollTop: 0,
};
