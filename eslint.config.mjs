import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
})

export default [
	...baseConfig,
	{
		// Command-line tools and tests: they import the built dist/ and exit with a status code
		files: ['test/**/*.mjs', 'tools/**/*.mjs'],
		rules: {
			'n/no-unpublished-import': 'off',
			'n/no-process-exit': 'off',
		},
	},
]
