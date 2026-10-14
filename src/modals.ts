/**
 * 通用确认弹窗：用于批量删除、拖拽移动等需要二次确认的操作
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { App, Modal, Setting } from "obsidian";

/**
 * 确认弹窗参数
 */
export interface ConfirmOptions {
	/** 标题 */
	title: string;
	/** 正文 */
	message: string;
	/** 确认按钮文案 */
	confirmText: string;
	/** 确认按钮是否为危险样式 */
	warning?: boolean;
	/** 是否显示“不再询问”勾选项 */
	showDontAsk?: boolean;
}

/**
 * 确认结果
 */
export interface ConfirmResult {
	/** 是否确认 */
	confirmed: boolean;
	/** 是否勾选了“不再询问” */
	dontAsk: boolean;
}

/**
 * 确认弹窗
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
class ConfirmModal extends Modal {
	/** 弹窗参数 */
	private readonly options: ConfirmOptions;
	/** 关闭时回传结果 */
	private readonly onResult: (result: ConfirmResult) => void;
	/** 是否已确认 */
	private confirmed = false;
	/** 是否勾选“不再询问” */
	private dontAsk = false;

	/**
	 * 创建弹窗
	 *
	 * @param app Obsidian 应用实例
	 * @param options 弹窗参数
	 * @param onResult 结果回调
	 */
	constructor(app: App, options: ConfirmOptions, onResult: (result: ConfirmResult) => void) {
		super(app);
		this.options = options;
		this.onResult = onResult;
	}

	/**
	 * 渲染弹窗内容
	 */
	onOpen(): void {
		const { contentEl, options } = this;
		this.titleEl.setText(options.title);
		contentEl.createEl("p", { text: options.message, cls: "vft-confirm-message" });
		// 可选的“不再询问”
		if (options.showDontAsk) {
			new Setting(contentEl).setName("不再询问").addToggle((toggle) =>
				toggle.setValue(false).onChange((value) => {
					this.dontAsk = value;
				}),
			);
		}
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()))
			.addButton((btn) => {
				btn.setButtonText(options.confirmText).onClick(() => {
					this.confirmed = true;
					this.close();
				});
				// 危险操作用警告样式，否则用主按钮样式
				if (options.warning) {
					btn.setWarning();
				} else {
					btn.setCta();
				}
			});
	}

	/**
	 * 关闭时回传结果
	 */
	onClose(): void {
		this.contentEl.empty();
		this.onResult({ confirmed: this.confirmed, dontAsk: this.confirmed && this.dontAsk });
	}
}

/**
 * 弹出确认框
 *
 * @param app Obsidian 应用实例
 * @param options 弹窗参数
 * @returns 确认结果
 */
export function confirm(app: App, options: ConfirmOptions): Promise<ConfirmResult> {
	return new Promise((resolve) => new ConfirmModal(app, options, resolve).open());
}
