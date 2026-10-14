/**
 * 文件操作：打开、新建、重命名、创建副本、删除、移动与外部文件导入
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { App, Keymap, Notice, PaneType, TAbstractFile, TFile, TFolder } from "obsidian";
import { getVaultConfig, isExtensionSupported, openWithDefaultApp, showInFolder } from "./internal";
import { confirm } from "./modals";
import type VscodeFileTreePlugin from "./main";
import { OpenLocation, UnsupportedFileAction } from "./types";

/** 新建笔记默认名称 */
const UNTITLED_NOTE = "未命名";
/** 新建文件夹默认名称 */
const UNTITLED_FOLDER = "未命名文件夹";
/** 文件名中不允许出现的字符 */
const INVALID_NAME_CHARS = /[\\/:]/;

/**
 * 拼接文件夹与名称得到完整路径
 *
 * @param folder 父文件夹
 * @param name 名称
 * @returns 库内相对路径
 */
export function joinPath(folder: TFolder, name: string): string {
	return folder.isRoot() ? name : `${folder.path}/${name}`;
}

/**
 * 拆分文件名为主名与扩展名
 *
 * @param name 文件名
 * @returns [主名, 扩展名]；没有扩展名时扩展名为空字符串
 */
function splitName(name: string): [string, string] {
	const idx = name.lastIndexOf(".");
	// 以点开头或没有点视为无扩展名
	return idx > 0 ? [name.slice(0, idx), name.slice(idx + 1)] : [name, ""];
}

/**
 * 文件操作集合
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export class FileActions {
	/** 插件实例 */
	private readonly plugin: VscodeFileTreePlugin;

	/**
	 * 创建操作集合
	 *
	 * @param plugin 插件实例
	 */
	constructor(plugin: VscodeFileTreePlugin) {
		this.plugin = plugin;
	}

	/** Obsidian 应用实例 */
	private get app(): App {
		return this.plugin.app;
	}

	/**
	 * 打开文件：Obsidian 支持的在标签页打开，不支持的按配置交给系统处理
	 *
	 * @param file 文件
	 * @param evt 触发事件（用于判断 Cmd/Ctrl、中键等修饰），可为空
	 * @returns 在 Obsidian 内打开返回 true，交给系统处理返回 false
	 */
	async openFile(file: TFile, evt: MouseEvent | KeyboardEvent | null): Promise<boolean> {
		const settings = this.plugin.settings;
		// region Obsidian 无法打开的文件
		if (!isExtensionSupported(this.app, file.extension)) {
			const ok =
				settings.unsupportedFileAction === UnsupportedFileAction.ShowInFolder
					? showInFolder(this.app, file.path) || openWithDefaultApp(this.app, file.path)
					: openWithDefaultApp(this.app, file.path) || showInFolder(this.app, file.path);
			if (!ok) {
				new Notice(`Obsidian 无法打开该类型文件：${file.name}`);
			}
			return false;
		}
		// endregion

		// region 计算打开位置
		const mod = evt ? Keymap.isModEvent(evt) : false;
		let target: PaneType | false;
		if (mod === "split" || mod === "window") {
			// Cmd+Alt 分屏、Cmd+Alt+Shift 新窗口，保持 Obsidian 原生行为
			target = mod;
		} else {
			// Cmd/Ctrl 或中键：在“当前标签页”和“新标签页”之间取反
			const modTab = mod === "tab" || mod === true;
			const wantTab = settings.openLocation === OpenLocation.NewTab ? !modTab : modTab;
			target = wantTab ? "tab" : false;
		}
		// endregion

		const leaf = this.app.workspace.getLeaf(target);
		await leaf.openFile(file, { active: true });
		return true;
	}

	/**
	 * 在文件夹下找一个不重名的路径
	 *
	 * @param folder 父文件夹
	 * @param base 主名
	 * @param ext 扩展名（不带点），文件夹传空字符串
	 * @returns 可用路径
	 */
	getAvailablePath(folder: TFolder, base: string, ext: string): string {
		// 同名比较忽略大小写（macOS 文件系统默认不区分大小写）
		const taken = new Set(folder.children.map((c) => c.name.toLowerCase()));
		for (let i = 0; ; i++) {
			const name = `${base}${i === 0 ? "" : ` ${i}`}${ext ? `.${ext}` : ""}`;
			if (!taken.has(name.toLowerCase())) {
				return joinPath(folder, name);
			}
		}
	}

	/**
	 * 新建空白笔记
	 *
	 * @param folder 所在文件夹
	 * @returns 新文件，失败返回 null
	 */
	async createNote(folder: TFolder): Promise<TFile | null> {
		try {
			return await this.app.vault.create(this.getAvailablePath(folder, UNTITLED_NOTE, "md"), "");
		} catch (e) {
			new Notice(`新建笔记失败：${String(e)}`);
			return null;
		}
	}

	/**
	 * 新建文件夹
	 *
	 * @param folder 父文件夹
	 * @returns 新文件夹，失败返回 null
	 */
	async createFolder(folder: TFolder): Promise<TFolder | null> {
		try {
			return await this.app.vault.createFolder(this.getAvailablePath(folder, UNTITLED_FOLDER, ""));
		} catch (e) {
			new Notice(`新建文件夹失败：${String(e)}`);
			return null;
		}
	}

	/**
	 * 创建副本（与原文件同目录，自动加序号）
	 *
	 * @param item 文件或文件夹
	 * @returns 副本，失败返回 null
	 */
	async duplicate(item: TAbstractFile): Promise<TAbstractFile | null> {
		const parent = item.parent;
		if (!parent) {
			return null;
		}
		try {
			if (item instanceof TFile) {
				return await this.app.vault.copy(item, this.getAvailablePath(parent, item.basename, item.extension));
			}
			return await this.app.vault.copy(item, this.getAvailablePath(parent, item.name, ""));
		} catch (e) {
			new Notice(`创建副本失败：${String(e)}`);
			return null;
		}
	}

	/**
	 * 重命名（会同步更新库内链接）
	 *
	 * @param item 文件或文件夹
	 * @param newName 新名称
	 * @returns 成功返回 true
	 */
	async rename(item: TAbstractFile, newName: string): Promise<boolean> {
		const parent = item.parent;
		if (!parent || newName === item.name) {
			return false;
		}
		// 校验非法字符
		if (INVALID_NAME_CHARS.test(newName)) {
			new Notice("文件名不能包含 \\ / : 字符");
			return false;
		}
		// 校验重名（只改大小写时允许）
		const newPath = joinPath(parent, newName);
		const exists = parent.children.some((c) => c !== item && c.name.toLowerCase() === newName.toLowerCase());
		if (exists) {
			new Notice(`已存在同名文件：${newName}`);
			return false;
		}
		try {
			await this.app.fileManager.renameFile(item, newPath);
			return true;
		} catch (e) {
			new Notice(`重命名失败：${String(e)}`);
			return false;
		}
	}

	/**
	 * 删除（遵循 Obsidian 的“删除前确认”与回收站配置）
	 *
	 * @param items 待删除项
	 */
	async deleteItems(items: TAbstractFile[]): Promise<void> {
		// 去掉已被选中的上级文件夹包含的子项，避免重复删除
		const paths = new Set(items.map((i) => i.path));
		const roots = items.filter((i) => !(i instanceof TFolder && i.isRoot()) && !hasSelectedAncestor(i, paths));
		if (roots.length === 0) {
			return;
		}
		// 单个：交给 Obsidian 原生流程
		if (roots.length === 1) {
			await this.app.fileManager.promptForDeletion(roots[0]);
			return;
		}
		// 多个：按 Obsidian 的“删除前确认”配置决定是否弹窗
		if (getVaultConfig(this.app, "promptDelete") !== false) {
			const result = await confirm(this.app, {
				title: "删除文件",
				message: `确定要删除选中的 ${roots.length} 项吗？`,
				confirmText: "删除",
				warning: true,
			});
			if (!result.confirmed) {
				return;
			}
		}
		for (const item of roots) {
			await this.app.fileManager.trashFile(item);
		}
	}

	/**
	 * 判断能否移动到目标文件夹
	 *
	 * @param item 待移动项
	 * @param target 目标文件夹
	 * @returns 可以移动返回 true
	 */
	canMoveTo(item: TAbstractFile, target: TFolder): boolean {
		// 已在目标文件夹下
		if (item.parent === target || item === target) {
			return false;
		}
		// 不能把文件夹移到自己的子孙文件夹中
		if (item instanceof TFolder && target.path.startsWith(`${item.path}/`)) {
			return false;
		}
		return true;
	}

	/**
	 * 移动到目标文件夹（会同步更新库内链接，重名时自动加序号）
	 *
	 * @param items 待移动项
	 * @param target 目标文件夹
	 * @returns 实际移动的项
	 */
	async moveItems(items: TAbstractFile[], target: TFolder): Promise<TAbstractFile[]> {
		const paths = new Set(items.map((i) => i.path));
		const movable = items.filter((i) => this.canMoveTo(i, target) && !hasSelectedAncestor(i, paths));
		if (movable.length === 0) {
			return [];
		}
		// 按配置弹窗确认
		if (this.plugin.settings.confirmBeforeMove) {
			const targetName = target.isRoot() ? this.app.vault.getName() : target.path;
			const what = movable.length === 1 ? `“${movable[0].name}”` : `选中的 ${movable.length} 项`;
			const result = await confirm(this.app, {
				title: "移动文件",
				message: `确定要将${what}移动到“${targetName}”吗？`,
				confirmText: "移动",
				showDontAsk: true,
			});
			if (!result.confirmed) {
				return [];
			}
			// 勾选“不再询问”后关闭确认
			if (result.dontAsk) {
				this.plugin.settings.confirmBeforeMove = false;
				await this.plugin.saveSettings();
			}
		}
		const moved: TAbstractFile[] = [];
		for (const item of movable) {
			const [base, ext] = item instanceof TFile ? [item.basename, item.extension] : [item.name, ""];
			try {
				await this.app.fileManager.renameFile(item, this.getAvailablePath(target, base, ext));
				moved.push(item);
			} catch (e) {
				new Notice(`移动“${item.name}”失败：${String(e)}`);
			}
		}
		return moved;
	}

	/**
	 * 导入从系统（如访达）拖入的文件
	 *
	 * @param files 拖入的文件
	 * @param target 目标文件夹
	 */
	async importExternalFiles(files: File[], target: TFolder): Promise<void> {
		let count = 0;
		for (const file of files) {
			try {
				// 文件夹拖入时读取会失败，直接跳过
				const data = await file.arrayBuffer();
				const [base, ext] = splitName(file.name);
				await this.app.vault.createBinary(this.getAvailablePath(target, base, ext), data);
				count++;
			} catch {
				new Notice(`无法导入：${file.name}（不支持拖入文件夹）`);
			}
		}
		if (count > 0) {
			new Notice(`已导入 ${count} 个文件`);
		}
	}
}

/**
 * 判断某项的上级文件夹是否也在待处理集合中
 *
 * @param item 文件或文件夹
 * @param paths 待处理路径集合
 * @returns 有上级在集合中返回 true
 */
function hasSelectedAncestor(item: TAbstractFile, paths: Set<string>): boolean {
	let parent = item.parent;
	// 逐级向上检查
	while (parent && !parent.isRoot()) {
		if (paths.has(parent.path)) {
			return true;
		}
		parent = parent.parent;
	}
	return false;
}
