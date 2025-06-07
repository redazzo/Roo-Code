import React, { useState, useCallback, useMemo, useReducer, DragEvent, useEffect } from "react"
import { VSCodeDropdown, VSCodeOption, VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { vscode } from "../../utils/vscode"

// --- Constants and Types

const TEXT_PLAIN = "text/plain"

const TTL_OPTIONS = [
	{ value: "10", label: "10 min" },
	{ value: "20", label: "20 min" },
	{ value: "30", label: "30 min" },
	{ value: "60", label: "60 min" },
]

const COMPONENT_STRINGS = {
	cachingTitle: "File Caching and Upload",
	ttlLabel: "TTL:",
	dropZoneDefault: "Drag content (files, directories, or text) here",
	dropZoneHover: "Drop here to cache",
	noContent: "No content staged or cached.",
}

interface UploadComponentProps {
	style?: React.CSSProperties
}

type TStagedItem = {
	entryType: "directory" | "file" | "unknown"
	name: string
	fullPath: string
	files?: string[]
}

// --- State Management with useReducer

type UploadState = {
	stagedContent: TStagedItem[] | null
	pendingActionContent: TStagedItem[] | null
	isContentCached: boolean
	isProcessing: boolean
	showClearConfirmation: boolean
}

type UploadAction =
	| { type: "SET_STAGED_CONTENT"; payload: TStagedItem[] }
	| { type: "REQUEST_CONFIRMATION"; payload: TStagedItem[] }
	| { type: "CONFIRM_AND_STAGE_NEW" }
	| { type: "CANCEL_CLEAR" }
	| { type: "START_UPLOAD" }
	| { type: "UPLOAD_SUCCESS" }
	| { type: "UPLOAD_ERROR" }
	| { type: "CLEAR_CACHE" }

const initialState: UploadState = {
	stagedContent: null,
	pendingActionContent: null,
	isContentCached: false,
	isProcessing: false,
	showClearConfirmation: false,
}

function uploadReducer(state: UploadState, action: UploadAction): UploadState {
	switch (action.type) {
		case "SET_STAGED_CONTENT":
			return { ...state, stagedContent: action.payload, isContentCached: false }
		case "REQUEST_CONFIRMATION":
			return { ...state, showClearConfirmation: true, pendingActionContent: action.payload }
		case "CONFIRM_AND_STAGE_NEW":
			return {
				...state,
				stagedContent: state.pendingActionContent,
				isContentCached: false,
				showClearConfirmation: false,
				pendingActionContent: null,
			}
		case "CANCEL_CLEAR":
			return { ...state, showClearConfirmation: false, pendingActionContent: null }
		case "START_UPLOAD":
			return { ...state, isProcessing: true }
		case "UPLOAD_SUCCESS":
			return { ...state, isProcessing: false, isContentCached: true }
		case "UPLOAD_ERROR":
			return { ...state, isProcessing: false }
		case "CLEAR_CACHE":
			return { ...initialState }
		default:
			return state
	}
}

// --- Helper Functions

const formatDisplayItems = (items: TStagedItem[] | null): string => {
	if (!items || items.length === 0) return COMPONENT_STRINGS.noContent

	return items
		.map((item) => {
			if (item.entryType === "directory") {
				return `📁 ${item.name} (${item.files?.length || 0} files)`
			}
			if (item.entryType === "file") {
				return `📄 ${item.name}`
			}
			return `❓ ${item.name}`
		})
		.join("\n")
}

// --- Child Component: Confirmation Modal

interface ConfirmationModalProps {
	isOpen: boolean
	onConfirm: () => void
	onCancel: () => void
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({ isOpen, onConfirm, onCancel }) => {
	if (!isOpen) return null

	return (
		<div style={styles.modalOverlay}>
			<div style={styles.modalContent}>
				<p style={styles.modalText}>
					Uploading new content will clear the existing cached content. Do you want to proceed?
				</p>
				<div style={styles.modalActions}>
					<VSCodeButton appearance="secondary" onClick={onCancel}>
						Cancel
					</VSCodeButton>
					<VSCodeButton onClick={onConfirm}>OK</VSCodeButton>
				</div>
			</div>
		</div>
	)
}

// --- Main Upload Component

const UploadComponent = ({ style }: UploadComponentProps) => {
	const [state, dispatch] = useReducer(uploadReducer, initialState)
	const { stagedContent, isContentCached, isProcessing, showClearConfirmation } = state

	const [isExpanded, setIsExpanded] = useState(true)
	const [selectedTtl, setSelectedTtl] = useState<string>(TTL_OPTIONS[0].value)
	const [isDraggingOver, setIsDraggingOver] = useState(false)

	const toggleExpanded = useCallback(() => setIsExpanded((prev) => !prev), [])

	// --- Message Handling Effect from VS Code Extension
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			switch (message.type) {
				case "processedItemToFileRequest": {
					const processedItems = message.values as TStagedItem[]
					if (processedItems?.length > 0) {
						if (isContentCached) {
							dispatch({ type: "REQUEST_CONFIRMATION", payload: processedItems })
						} else {
							dispatch({ type: "SET_STAGED_CONTENT", payload: processedItems })
						}
					} else {
						console.warn("No valid processed items received.")
					}
					break
				}
				case "uploadContentProcessed":
					dispatch({ type: "UPLOAD_SUCCESS" })
					console.log("Upload content processed:", message.values.items)
					break
				case "uploadContentError":
					dispatch({ type: "UPLOAD_ERROR" })
					console.error("Upload content error:", message.text)
					break
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [isContentCached])

	// --- Event Handlers

	const handleTtlChange = useCallback((event: any) => {
		setSelectedTtl(event.target.value)
	}, [])

	const handleDrop = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			event.preventDefault()
			event.stopPropagation()
			setIsDraggingOver(false)

			const items = event.dataTransfer.items
			if (!items) return

			for (let i = 0; i < items.length; i++) {
				if (items[i].type === TEXT_PLAIN) {
					items[i].getAsString((paths) => {
						const thePathsArray = paths
							.split("\n")
							.map((p) => p.trim())
							.filter(Boolean)
						vscode.postMessage({
							type: "processItemToFile",
							values: { items: thePathsArray, ttl: selectedTtl },
						})
					})
				}
			}
		},
		[selectedTtl],
	)

	const handleUploadClick = useCallback(() => {
		if (!stagedContent) return
		dispatch({ type: "START_UPLOAD" })
		vscode.postMessage({
			type: "uploadContent",
			values: { items: stagedContent, ttl: selectedTtl },
		})
	}, [stagedContent, selectedTtl])

	const dragHandlers = {
		onDragEnter: useCallback((event: DragEvent<HTMLDivElement>) => {
			event.preventDefault()
			event.stopPropagation()
			setIsDraggingOver(true)
		}, []),
		onDragLeave: useCallback((event: DragEvent<HTMLDivElement>) => {
			event.preventDefault()
			event.stopPropagation()
			setIsDraggingOver(false)
		}, []),
		onDragOver: useCallback((event: DragEvent<HTMLDivElement>) => {
			event.preventDefault()
			event.stopPropagation()
		}, []),
		onDrop: handleDrop,
	}

	// --- Memoized Derived State for Rendering

	const dropZoneText = useMemo(() => {
		if (isDraggingOver) return COMPONENT_STRINGS.dropZoneHover
		if (isContentCached) {
			return `Cached:\n${formatDisplayItems(stagedContent)}\n\nTTL: ${selectedTtl} min.\nDrop to replace.`
		}
		if (stagedContent) {
			return `\n${formatDisplayItems(stagedContent)}\n`
		}
		return COMPONENT_STRINGS.dropZoneDefault
	}, [isDraggingOver, stagedContent, isContentCached, selectedTtl])

	const uploadButtonTitle = !stagedContent
		? "Drop content to enable upload"
		: isContentCached
			? "Content is already cached"
			: isProcessing
				? "Processing upload..."
				: "Upload staged content"

	return (
		<div style={{ ...styles.container, ...style }}>
			<div
				style={styles.header}
				onClick={toggleExpanded}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggleExpanded()}>
				<span>{COMPONENT_STRINGS.cachingTitle}</span>
				<span className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`}></span>
			</div>

			{isExpanded && (
				<div style={styles.contentArea}>
					<div style={styles.mainPanel}>
						<div
							{...dragHandlers}
							style={{ ...styles.dropZone, ...(isDraggingOver && styles.dropZoneHover) }}>
							<div
								style={{
									...styles.dropZoneInner,
									textAlign: stagedContent || isContentCached ? "left" : "center",
								}}>
								{dropZoneText}
							</div>
						</div>

						<div style={styles.buttonGroup}>
							<VSCodeButton
								onClick={handleUploadClick}
								disabled={!stagedContent || isContentCached || isProcessing}
								style={styles.button}
								title={uploadButtonTitle}>
								<span
									className={`codicon ${isProcessing ? "codicon-loading codicon-modifier-spin" : "codicon-cloud-upload"}`}
									style={styles.icon}></span>
								{isProcessing ? "Processing..." : "Upload"}
							</VSCodeButton>
							<VSCodeButton
								appearance="secondary"
								onClick={() => dispatch({ type: "CLEAR_CACHE" })}
								disabled={!isContentCached}
								style={styles.button}
								title={!isContentCached ? "No content cached to clear" : "Clear all cached content"}>
								<span className="codicon codicon-trash" style={styles.icon}></span>
								Clear Cache
							</VSCodeButton>
						</div>
					</div>

					<div style={styles.ttlPanel}>
						<label htmlFor="ttl-select" style={styles.ttlLabel}>
							{COMPONENT_STRINGS.ttlLabel}
						</label>
						<VSCodeDropdown
							id="ttl-select"
							value={selectedTtl}
							onChange={handleTtlChange}
							style={{ flex: 1 }}
							disabled={isContentCached}>
							{TTL_OPTIONS.map((option) => (
								<VSCodeOption key={option.value} value={option.value}>
									{option.label}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
					</div>
				</div>
			)}

			<ConfirmationModal
				isOpen={showClearConfirmation}
				onConfirm={() => dispatch({ type: "CONFIRM_AND_STAGE_NEW" })}
				onCancel={() => dispatch({ type: "CANCEL_CLEAR" })}
			/>
		</div>
	)
}

// --- Styles (abstracted from JSX) ---

const styles: { [key: string]: React.CSSProperties } = {
	container: {
		padding: "10px",
		border: "1px solid var(--vscode-settings-sashBorder)",
		borderRadius: "5px",
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		cursor: "pointer",
		marginBottom: "10px",
	},
	contentArea: {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
	},
	mainPanel: {
		display: "flex",
		gap: "10px",
		alignItems: "flex-start",
	},
	dropZone: {
		width: "100%",
		height: "150px",
		borderWidth: "2px",
		borderStyle: "dashed",
		borderColor: "var(--vscode-input-border, var(--vscode-descriptionForeground))",
		backgroundColor: "var(--vscode-input-background)",
		display: "flex",
		flexDirection: "column",
		alignItems: "stretch",
		justifyContent: "flex-start",
		color: "var(--vscode-descriptionForeground)",
		transition: "border-color 0.2s, background-color 0.2s",
		borderRadius: "4px",
		overflow: "hidden",
	},
	dropZoneHover: {
		borderColor: "var(--vscode-focusBorder)",
		backgroundColor: "var(--vscode-list-hoverBackground)",
	},
	dropZoneInner: {
		flex: 1,
		width: "100%",
		minHeight: 0,
		overflow: "auto",
		padding: "10px",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		color: "inherit",
	},
	buttonGroup: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		justifyContent: "flex-start",
	},
	button: {
		width: "120px",
	},
	icon: {
		marginRight: "5px",
	},
	ttlPanel: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		marginTop: "10px",
	},
	ttlLabel: {
		color: "var(--vscode-foreground)",
		flexShrink: 0,
	},
	modalOverlay: {
		position: "fixed",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: "rgba(0, 0, 0, 0.5)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 1000,
	},
	modalContent: {
		backgroundColor: "var(--vscode-editorWidget-background)",
		padding: "20px",
		borderRadius: "5px",
		boxShadow: "0 4px 8px rgba(0,0,0,0.2)",
		textAlign: "center",
		border: "1px solid var(--vscode-editorWidget-border)",
	},
	modalText: {
		color: "var(--vscode-editorWidget-foreground)",
		marginBlockStart: 0,
		marginBlockEnd: "1em",
	},
	modalActions: {
		display: "flex",
		justifyContent: "flex-end",
		gap: "10px",
	},
}

export default UploadComponent
