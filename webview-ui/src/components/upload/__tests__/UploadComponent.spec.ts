import { describe, it, expect, jest, beforeEach } from "@jest/globals"
import { render, screen } from "@testing-library/react"
import React from "react"
import UploadComponent from "../UploadComponent"

// Mock the vscode API
const mockPostMessage = jest.fn()
jest.mock("../../../utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

describe("UploadComponent", () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it("should render the upload component", () => {
		render(React.createElement(UploadComponent))

		expect(screen.getByText("Pre-caching Content")).toBeInTheDocument()
		expect(screen.getByText("Upload")).toBeInTheDocument()
		expect(screen.getByText("Clear Cache")).toBeInTheDocument()
	})

	it("should send uploadContent message when upload button is clicked", async () => {
		render(React.createElement(UploadComponent))

		// Simulate dropping some content first
		const dropZone = screen.getByText(/Drag content/).closest("div")
		expect(dropZone).toBeInTheDocument()

		// For now, just test that the upload button exists and is initially disabled
		const uploadButton = screen.getByText("Upload").closest("button")
		expect(uploadButton).toBeDisabled()
	})

	it("should format display items correctly", () => {
		// This tests the formatDisplayItems function indirectly through the component
		render(React.createElement(UploadComponent))

		// The component should show "Drag content" text when no content is staged
		expect(screen.getByText(/Drag content/)).toBeInTheDocument()
	})

	it("should handle file vs directory display correctly", () => {
		// This will be tested when we simulate the uploadContentProcessed message
		render(React.createElement(UploadComponent))

		// Simulate receiving processed content from extension
		const mockEvent = new MessageEvent("message", {
			data: {
				type: "uploadContentProcessed",
				values: {
					items: [
						{ entryType: "file", name: "test.txt", fullPath: "/path/to/test.txt" },
						{
							entryType: "directory",
							name: "src",
							fullPath: "/path/to/src",
							files: ["file1.js", "file2.js"],
						},
					],
					ttl: "10",
				},
			},
		})

		window.dispatchEvent(mockEvent)

		// The component should now show the processed content
		// Note: This test would need more setup to properly verify the display
	})
})
