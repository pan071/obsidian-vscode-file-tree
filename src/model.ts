/**
 * 文件树数据模型：根据过滤、搜索、排序、紧凑文件夹等配置计算每一轮渲染的可见结构
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { ExtensionDisplay, FileTreeSettings, FilterMode, SearchScope, SortOrder } from "./types";

/** 自然排序比较器（数字按大小比较，忽略大小写） */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * 判断路径是否等于某文件夹或位于其下
 *
 * @param path 待判断路径
 * @param folders 文件夹路径列表
 * @returns 命中任一文件夹返回 true
 */
export function isUnderFolders(path: string, folders: string[]): boolean {
	return folders.some((folder) => {
		const f = folder.replace(/^\/+|\/+$/g, "");
		return f.length > 0 && (path === f || path.startsWith(`${f}/`));
	});
}

/**
 * 获取某路径的所有上级文件夹路径（由近到远，不含根）
 *
 * @param path 文件或文件夹路径
 * @returns 上级路径列表
 */
export function getAncestorPaths(path: string): string[] {
	const result: string[] = [];
	let idx = path.lastIndexOf("/");
	// 逐级截掉最后一段
	while (idx > 0) {
		path = path.slice(0, idx);
		result.push(path);
		idx = path.lastIndexOf("/");
	}
	return result;
}

/**
 * 文件树模型，每次渲染前调用 build() 计算可见集合
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export class TreeModel {
	/** 库实例 */
	private readonly vault: Vault;
	/** 插件配置 */
	private settings: FileTreeSettings;
	/** 本轮可见的路径集合 */
	private visible = new Set<string>();
	/** 文件夹路径 → 可见文件数（递归） */
	private fileCounts = new Map<string, number>();
	/** 搜索时因包含命中项而需要强制展开的文件夹 */
	private searchExpanded = new Set<string>();
	/** 当前搜索关键词（已按大小写配置归一化），无搜索时为空数组 */
	private searchTerms: string[] = [];

	/**
	 * 创建模型
	 *
	 * @param vault 库实例
	 * @param settings 插件配置
	 */
	constructor(vault: Vault, settings: FileTreeSettings) {
		this.vault = vault;
		this.settings = settings;
	}

	/**
	 * 更新配置引用（设置页修改后）
	 *
	 * @param settings 插件配置
	 */
	setSettings(settings: FileTreeSettings): void {
		this.settings = settings;
	}

	/**
	 * 当前是否处于搜索状态
	 *
	 * @returns 有搜索关键词返回 true
	 */
	isSearching(): boolean {
		return this.searchTerms.length > 0;
	}

	/**
	 * 获取归一化后的搜索关键词
	 *
	 * @returns 关键词列表
	 */
	getSearchTerms(): string[] {
		return this.searchTerms;
	}

	/**
	 * 重新计算可见结构
	 *
	 * @param query 搜索文本，空格分隔多个关键词（需全部命中）
	 */
	build(query: string): void {
		const normalized = this.settings.searchCaseSensitive ? query : query.toLowerCase();
		this.searchTerms = normalized.split(/\s+/).filter((t) => t.length > 0);
		this.visible = new Set<string>();
		this.fileCounts = new Map<string, number>();
		this.searchExpanded = new Set<string>();
		// 从根开始递归计算
		this.visit(this.vault.getRoot(), false);
		this.visible.add("/");
	}

	/**
	 * 递归计算文件夹可见性
	 *
	 * @param folder 文件夹
	 * @param ancestorMatched 上级文件夹是否已命中搜索（命中后其下内容全部可见）
	 * @returns [可见文件数, 子孙中是否有搜索命中项]
	 */
	private visit(folder: TFolder, ancestorMatched: boolean): [number, boolean] {
		const searching = this.isSearching();
		const selfMatched = searching && !folder.isRoot() && this.matchesSearch(folder);
		const matchedScope = ancestorMatched || selfMatched;
		let count = 0;
		let descendantMatched = false;

		for (const child of folder.children) {
			if (child instanceof TFolder) {
				// 隐藏的文件夹整棵跳过
				if (isUnderFolders(child.path, this.settings.hiddenFolders)) {
					continue;
				}
				const [childCount, childMatched] = this.visit(child, matchedScope);
				count += childCount;
				descendantMatched = descendantMatched || childMatched;
			} else if (child instanceof TFile) {
				if (!this.passesFilter(child)) {
					continue;
				}
				// 搜索时：文件自身命中，或位于命中的文件夹下才可见
				const fileMatched = searching && this.matchesSearch(child);
				if (searching && !fileMatched && !matchedScope) {
					continue;
				}
				this.visible.add(child.path);
				count++;
				descendantMatched = descendantMatched || fileMatched;
			}
		}

		this.fileCounts.set(folder.path, count);
		if (!folder.isRoot()) {
			let show: boolean;
			if (searching) {
				// 搜索时：自身命中、上级命中或包含命中项才显示
				show = matchedScope || descendantMatched;
			} else {
				// 非搜索时：按“隐藏空文件夹”配置决定
				show = !this.settings.hideEmptyFolders || count > 0;
			}
			if (show) {
				this.visible.add(folder.path);
			}
			// 包含命中项的文件夹在搜索时强制展开
			if (searching && descendantMatched) {
				this.searchExpanded.add(folder.path);
			}
		}
		return [count, descendantMatched || selfMatched];
	}

	/**
	 * 判断文件是否通过扩展名过滤
	 *
	 * @param file 文件
	 * @returns 通过返回 true
	 */
	passesFilter(file: TFile): boolean {
		const mode = this.settings.filterMode;
		if (mode === FilterMode.All) {
			return true;
		}
		const name = file.name.toLowerCase();
		// 支持多段扩展名，如 excalidraw.md
		const hit = this.settings.filterExtensions.some((ext) => name.endsWith(`.${ext}`));
		return mode === FilterMode.Blacklist ? !hit : hit;
	}

	/**
	 * 判断文件或文件夹是否命中搜索
	 *
	 * @param item 文件或文件夹
	 * @returns 全部关键词都命中返回 true
	 */
	private matchesSearch(item: TAbstractFile): boolean {
		const raw = this.settings.searchScope === SearchScope.Path ? item.path : item.name;
		const target = this.settings.searchCaseSensitive ? raw : raw.toLowerCase();
		return this.searchTerms.every((term) => target.includes(term));
	}

	/**
	 * 路径在本轮是否可见
	 *
	 * @param path 路径
	 * @returns 可见返回 true
	 */
	isVisible(path: string): boolean {
		return this.visible.has(path);
	}

	/**
	 * 搜索时是否需要强制展开
	 *
	 * @param path 文件夹路径
	 * @returns 需要强制展开返回 true
	 */
	isSearchExpanded(path: string): boolean {
		return this.searchExpanded.has(path);
	}

	/**
	 * 获取文件夹下可见文件数（递归）
	 *
	 * @param path 文件夹路径
	 * @returns 文件数
	 */
	getFileCount(path: string): number {
		return this.fileCounts.get(path) ?? 0;
	}

	/**
	 * 获取文件夹下排序后的可见子项
	 *
	 * @param folder 文件夹
	 * @returns 子项列表
	 */
	getChildren(folder: TFolder): TAbstractFile[] {
		const children = folder.children.filter((c) => this.visible.has(c.path));
		const folders = children.filter((c): c is TFolder => c instanceof TFolder);
		const files = children.filter((c): c is TFile => c instanceof TFile);
		const order = this.settings.sortOrder;
		const desc = order === SortOrder.NameDesc;
		// 文件夹始终按名称排序
		folders.sort((a, b) => (desc ? -1 : 1) * collator.compare(a.name, b.name));
		files.sort((a, b) => this.compareFiles(a, b));
		// 按时间排序时文件夹固定在前；按名称排序时由配置决定
		const isNameSort = order === SortOrder.NameAsc || order === SortOrder.NameDesc;
		if (isNameSort && !this.settings.foldersFirst) {
			return [...folders, ...files].sort((a, b) => (desc ? -1 : 1) * collator.compare(a.name, b.name));
		}
		return [...folders, ...files];
	}

	/**
	 * 按配置比较两个文件
	 *
	 * @param a 文件 A
	 * @param b 文件 B
	 * @returns 比较结果
	 */
	private compareFiles(a: TFile, b: TFile): number {
		const byName = collator.compare(a.name, b.name);
		switch (this.settings.sortOrder) {
			case SortOrder.NameDesc:
				return -byName;
			case SortOrder.ModifiedDesc:
				return b.stat.mtime - a.stat.mtime || byName;
			case SortOrder.ModifiedAsc:
				return a.stat.mtime - b.stat.mtime || byName;
			case SortOrder.CreatedDesc:
				return b.stat.ctime - a.stat.ctime || byName;
			case SortOrder.CreatedAsc:
				return a.stat.ctime - b.stat.ctime || byName;
			default:
				return byName;
		}
	}

	/**
	 * 计算紧凑文件夹链：从 folder 开始，只要可见子项恰好是一个文件夹就继续向下合并
	 *
	 * @param folder 起始文件夹
	 * @returns 文件夹链（至少包含 folder 本身）
	 */
	getCompactChain(folder: TFolder): TFolder[] {
		const chain = [folder];
		if (!this.settings.compactFolders) {
			return chain;
		}
		let current = folder;
		// 逐级向下合并
		for (;;) {
			const children = current.children.filter((c) => this.visible.has(c.path));
			if (children.length !== 1 || !(children[0] instanceof TFolder)) {
				break;
			}
			current = children[0];
			chain.push(current);
		}
		return chain;
	}

	/**
	 * 计算展示名称
	 *
	 * @param item 文件或文件夹
	 * @returns 展示名称
	 */
	getDisplayName(item: TAbstractFile): string {
		if (!(item instanceof TFile)) {
			return item.name;
		}
		const display = this.settings.extensionDisplay;
		// 全部隐藏，或只隐藏 md
		if (display === ExtensionDisplay.HideAll || (display === ExtensionDisplay.HideMarkdown && item.extension === "md")) {
			return item.basename;
		}
		return item.name;
	}
}
