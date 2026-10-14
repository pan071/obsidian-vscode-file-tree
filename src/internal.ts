/**
 * Obsidian 未公开 API 的类型声明与安全调用封装，所有调用都带存在性判断，缺失时降级
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { App, Menu, TAbstractFile, TFile, TFolder } from "obsidian";

/**
 * 拖拽数据（dragManager 内部结构）
 */
export interface DragData {
	/** 拖拽类型：file / folder / files / link 等 */
	type: string;
	/** 单个文件或文件夹 */
	file?: TAbstractFile | null;
	/** 多选拖拽时的文件列表 */
	files?: TAbstractFile[];
	/** 拖拽来源标识 */
	source?: string;
}

/**
 * 拖放回调返回值（dragManager 内部结构）
 */
export interface DropResult {
	/** 拖拽提示文案 */
	action?: string;
	/** 光标效果 */
	dropEffect?: "move" | "copy" | "link" | "none";
	/** 需要高亮的目标元素 */
	hoverEl?: HTMLElement;
	/** 高亮样式类名 */
	hoverClass?: string;
}

/**
 * 拖放回调签名
 */
export type DropHandler = (evt: DragEvent, draggable: DragData | null, isOver: boolean) => DropResult | undefined | void;

/**
 * Obsidian 内部拖拽管理器
 */
export interface DragManager {
	/** 当前正在拖拽的数据 */
	draggable: DragData | null;
	/** 让元素可拖拽，dragstart 时调用回调生成拖拽数据 */
	handleDrag(el: HTMLElement, cb: (evt: DragEvent) => DragData | null): void;
	/** 注册拖放目标；acceptExternal 为 true 时同时接收外部（如访达）拖入 */
	handleDrop(el: HTMLElement, cb: DropHandler, acceptExternal?: boolean): void;
	/** 生成单文件拖拽数据（拖进编辑器时插入链接） */
	dragFile(evt: DragEvent, file: TFile, source?: string): DragData;
	/** 生成文件夹拖拽数据 */
	dragFolder(evt: DragEvent, folder: TFolder, source?: string): DragData;
	/** 生成多文件拖拽数据 */
	dragFiles(evt: DragEvent, files: TAbstractFile[], source?: string): DragData | null;
	/** 给拖拽源元素加样式 */
	updateSource?(els: HTMLElement[] | null, cls: string): void;
}

/**
 * Material Icon Theme 插件实例中本插件用到的方法
 */
interface MaterialIconPlugin {
	/** 插件配置 */
	settings?: { applyToFiles?: boolean; applyToFolders?: boolean };
	/** 按路径获取文件图标 SVG */
	getFileIconSvg?(path: string): string;
	/** 按路径与折叠状态获取文件夹图标 key */
	getFolderIconKey?(path: string, collapsed: boolean): string;
	/** 按 key 获取图标集合 */
	getIconSet?(key: string): unknown;
	/** 按当前亮暗主题取出 SVG */
	getSvg?(iconSet: unknown): string;
}

/** Material Icon Theme 插件 ID */
const MATERIAL_ICON_PLUGIN_ID = "material-icon-theme";

/**
 * 应用实例上的内部字段
 */
interface InternalApp {
	dragManager?: DragManager;
	viewRegistry?: { isExtensionRegistered?(ext: string): boolean };
	openWithDefaultApp?(path: string): void;
	showInFolder?(path: string): void;
	vault: { getConfig?(key: string): unknown };
	plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> };
}

/**
 * 转为内部应用类型
 *
 * @param app Obsidian 应用实例
 * @returns 带内部字段的应用实例
 */
function internal(app: App): InternalApp {
	return app as unknown as InternalApp;
}

/**
 * 获取拖拽管理器
 *
 * @param app Obsidian 应用实例
 * @returns 拖拽管理器，不存在时返回 null
 */
export function getDragManager(app: App): DragManager | null {
	const dm = internal(app).dragManager;
	// 关键方法齐全才认为可用
	return dm && typeof dm.handleDrag === "function" && typeof dm.handleDrop === "function" ? dm : null;
}

/**
 * 判断 Obsidian 能否在内部打开该扩展名
 *
 * @param app Obsidian 应用实例
 * @param extension 扩展名（不带点）
 * @returns 能打开返回 true；无法判断时按能打开处理
 */
export function isExtensionSupported(app: App, extension: string): boolean {
	const registry = internal(app).viewRegistry;
	// 无法判断时交给 Obsidian 自己处理
	if (!registry || typeof registry.isExtensionRegistered !== "function") {
		return true;
	}
	return registry.isExtensionRegistered(extension.toLowerCase());
}

/**
 * 用系统默认程序打开文件
 *
 * @param app Obsidian 应用实例
 * @param path 库内相对路径
 * @returns 是否调用成功
 */
export function openWithDefaultApp(app: App, path: string): boolean {
	const fn = internal(app).openWithDefaultApp;
	if (typeof fn !== "function") {
		return false;
	}
	fn.call(app, path);
	return true;
}

/**
 * 在系统文件管理器（访达）中显示文件
 *
 * @param app Obsidian 应用实例
 * @param path 库内相对路径
 * @returns 是否调用成功
 */
export function showInFolder(app: App, path: string): boolean {
	const fn = internal(app).showInFolder;
	if (typeof fn !== "function") {
		return false;
	}
	fn.call(app, path);
	return true;
}

/**
 * 读取库配置（.obsidian/app.json）
 *
 * @param app Obsidian 应用实例
 * @param key 配置键
 * @returns 配置值，读取失败返回 undefined
 */
export function getVaultConfig(app: App, key: string): unknown {
	const fn = internal(app).vault.getConfig;
	return typeof fn === "function" ? fn.call(app.vault, key) : undefined;
}

/**
 * 声明菜单分组顺序，与自带文件列表保持一致，保证其他插件追加的菜单项排在正确位置
 *
 * @param menu 菜单实例
 */
export function addFileMenuSections(menu: Menu): void {
	const fn = (menu as unknown as { addSections?(sections: string[]): Menu }).addSections;
	if (typeof fn === "function") {
		fn.call(menu, ["title", "open", "action-primary", "action", "info", "info.copy", "view", "system", "", "danger"]);
	}
}

/**
 * Material Icon Theme 图标适配器：插件已启用且方法齐全时可取到 SVG
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export class MaterialIconAdapter {
	/** 插件实例 */
	private readonly plugin: MaterialIconPlugin;

	/**
	 * 创建适配器
	 *
	 * @param plugin Material Icon Theme 插件实例
	 */
	private constructor(plugin: MaterialIconPlugin) {
		this.plugin = plugin;
	}

	/**
	 * 尝试获取适配器
	 *
	 * @param app Obsidian 应用实例
	 * @returns 插件未启用或接口不兼容时返回 null
	 */
	static tryGet(app: App): MaterialIconAdapter | null {
		const plugins = internal(app).plugins;
		// 插件必须处于启用状态
		if (!plugins?.enabledPlugins?.has(MATERIAL_ICON_PLUGIN_ID)) {
			return null;
		}
		const plugin = plugins.plugins?.[MATERIAL_ICON_PLUGIN_ID] as MaterialIconPlugin | undefined;
		// 校验用到的方法都存在，防止插件升级后接口变化导致报错
		if (
			!plugin ||
			typeof plugin.getFileIconSvg !== "function" ||
			typeof plugin.getFolderIconKey !== "function" ||
			typeof plugin.getIconSet !== "function" ||
			typeof plugin.getSvg !== "function"
		) {
			return null;
		}
		return new MaterialIconAdapter(plugin);
	}

	/**
	 * 获取文件图标
	 *
	 * @param path 文件路径
	 * @returns SVG 字符串；该插件关闭了文件图标或出错时返回 null
	 */
	getFileSvg(path: string): string | null {
		// 尊重该插件自己的“文件图标”开关
		if (this.plugin.settings?.applyToFiles === false) {
			return null;
		}
		try {
			return this.plugin.getFileIconSvg?.(path) || null;
		} catch {
			return null;
		}
	}

	/**
	 * 获取文件夹图标
	 *
	 * @param path 文件夹路径
	 * @param collapsed 是否折叠
	 * @returns SVG 字符串；该插件关闭了文件夹图标或出错时返回 null
	 */
	getFolderSvg(path: string, collapsed: boolean): string | null {
		// 尊重该插件自己的“文件夹图标”开关
		if (this.plugin.settings?.applyToFolders === false) {
			return null;
		}
		try {
			const p = this.plugin;
			const key = p.getFolderIconKey?.(path, collapsed);
			if (!key) {
				return null;
			}
			return p.getSvg?.(p.getIconSet?.(key)) || null;
		} catch {
			return null;
		}
	}
}
