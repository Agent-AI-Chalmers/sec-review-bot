async function chooseSelect(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

export async function openPublishedRepositoryRun({
  name,
  page,
  base,
  waitUntil
}) {
  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Runs' }).waitFor()

  // A repository review publishes one step per delivery plus two summaries, so a
  // published one must render the multi-step delivery list.
  await chooseSelect(page, 'Workflow', 'Repository review')
  await chooseSelect(page, 'Publication', 'Published')
  // The unfiltered list already starts with an active repository review. Observe both
  // cells before opening the first row so a stale response cannot select that run.
  await waitUntil(async () => {
    const firstRow = page.locator('tbody tr:first-child')
    if ((await firstRow.count()) === 0) return false
    const workflowCell = (
      (await firstRow.locator('td:nth-child(2)').textContent()) ?? ''
    ).trim()
    const publicationCell = (
      (await firstRow.locator('td:nth-child(6)').textContent()) ?? ''
    ).trim()
    return (
      workflowCell === 'Repository review' &&
      publicationCell.includes('Published')
    )
  }, `${name} the repository-review and published filters must both apply to the list`)
  await page.locator('tbody tr:first-child td a').first().click()
  await page.waitForSelector('.run-progress-timeline')
}
