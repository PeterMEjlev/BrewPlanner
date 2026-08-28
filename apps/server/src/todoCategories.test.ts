import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The collapsible sections on the To-Do page.
 *
 * The invariant worth pinning is what a delete does: a category *looks* like it
 * contains its tasks, so deleting one reads like deleting them too — and it
 * must not. The tasks are kept and fall back to "Uncategorised". That is a
 * foreign key `on delete set null`, which SQLite only honours with
 * `foreign_keys = ON` and which drizzle-kit silently omits from the generated
 * `alter table ... add column` (it is restored by hand in
 * drizzle/0030_tense_mephisto.sql). Both halves are invisible until someone
 * deletes a category and finds their tasks gone with it, so they are tested
 * here rather than trusted.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

let booted: Promise<typeof import('./repo.js')> | null = null;

function boot(): Promise<typeof import('./repo.js')> {
  if (!booted) {
    booted = (async () => {
      process.env.DATABASE_PATH = join(tmpdir(), `brewplanner-todo-categories-${randomUUID()}.sqlite`);
      const database = await import('./db/index.js');
      database.runMigrations();
      return import('./repo.js');
    })();
  }
  return booted;
}

test('a task files into a category, and can be moved back out of it', async () => {
  const repo = await boot();
  const cleaning = repo.createTodoCategory('Cleaning');

  const filed = repo.createTodo('Scrub the mash tun', cleaning.id);
  assert.equal(filed.categoryId, cleaning.id);

  // Null is a real destination, not "leave it alone" — it means Uncategorised.
  const loose = repo.updateTodo(filed.id, { categoryId: null });
  assert.equal(loose?.categoryId, null);

  const back = repo.updateTodo(filed.id, { categoryId: cleaning.id });
  assert.equal(back?.categoryId, cleaning.id);
});

test('a task created without a category is Uncategorised', async () => {
  const repo = await boot();
  const todo = repo.createTodo('Order more caustic');
  assert.equal(todo.categoryId, null);
});

test('deleting a category keeps its tasks and returns them to Uncategorised', async () => {
  const repo = await boot();
  const maintenance = repo.createTodoCategory('Maintenance');
  const first = repo.createTodo('Replace the pump seal', maintenance.id);
  const second = repo.createTodo('Descale the HLT', maintenance.id);

  assert.equal(repo.deleteTodoCategory(maintenance.id), true);

  // The tasks are still there — losing a task to a tidy-up would be far worse
  // than losing the label on it.
  const after = repo.listTodos();
  const ids = after.map((t) => t.id);
  assert.ok(ids.includes(first.id), 'the first task survived its category');
  assert.ok(ids.includes(second.id), 'the second task survived its category');
  for (const id of [first.id, second.id]) {
    assert.equal(after.find((t) => t.id === id)?.categoryId, null);
  }

  // And the category itself is gone, so the page stops drawing a section for it.
  assert.equal(
    repo.listTodoCategories().some((c) => c.id === maintenance.id),
    false,
  );
});

test('renaming a category leaves the tasks filed under it', async () => {
  const repo = await boot();
  const category = repo.createTodoCategory('Brewday');
  const todo = repo.createTodo('Calibrate the refractometer', category.id);

  const renamed = repo.renameTodoCategory(category.id, 'Brew day prep');
  assert.equal(renamed?.name, 'Brew day prep');
  assert.equal(repo.listTodos().find((t) => t.id === todo.id)?.categoryId, category.id);
});

test('renaming or deleting a category that is gone reports it rather than throwing', async () => {
  const repo = await boot();
  assert.equal(repo.renameTodoCategory(9_999, 'Nowhere'), null);
  assert.equal(repo.deleteTodoCategory(9_999), false);
});

test('categories come back in the order they were created', async () => {
  const repo = await boot();
  const before = repo.listTodoCategories().length;
  const first = repo.createTodoCategory('Aaa last alphabetically it is not');
  const second = repo.createTodoCategory('Bbb');

  const listed = repo.listTodoCategories().slice(before);
  assert.deepEqual(
    listed.map((c) => c.id),
    [first.id, second.id],
  );
});
