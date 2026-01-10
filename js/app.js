const form = document.getElementById('form');
const taskInput = document.getElementById('taskInput');
const taskList = document.getElementById('taskList');
const counter = document.getElementById('counter');
const filterButtons = document.querySelectorAll('.filters button');

let tasks = JSON.parse(localStorage.getItem('tasks')) || [];
let currentFilter = 'all';

form.addEventListener('submit', addTask);

filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        currentFilter = btn.dataset.filter;
        renderTasks();
    });
});

function addTask(e) {
    e.preventDefault();
    const text = taskInput.value.trim();
    if (text === '') {
        alert('La tarea no puede estar vacía');
        return;
    }

    tasks.push({
        id: Date.now(),
        text,
        completed: false
    });

    taskInput.value = '';
    saveTasks();
    renderTasks();
}

function toggleTask(id) {
    tasks = tasks.map(task =>
        task.id === id ? { ...task, completed: !task.completed } : task
    );
    saveTasks();
    renderTasks();
}

function deleteTask(id) {
    if (!confirm('¿Eliminar esta tarea?')) return;
    tasks = tasks.filter(task => task.id !== id);
    saveTasks();
    renderTasks();
}

function renderTasks() {
    taskList.innerHTML = '';

    const filteredTasks = tasks.filter(task => {
        if (currentFilter === 'completed') return task.completed;
        if (currentFilter === 'pending') return !task.completed;
        return true;
    });

    filteredTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = `task ${task.completed ? 'completed' : ''}`;

        li.innerHTML = `
            <span>${task.text}</span>
            <div>
                <button onclick="toggleTask(${task.id})">✔</button>
                <button onclick="deleteTask(${task.id})">✖</button>
            </div>
        `;

        taskList.appendChild(li);
    });

    updateCounter();
}

function updateCounter() {
    const pending = tasks.filter(task => !task.completed).length;
    counter.textContent = `Tareas pendientes: ${pending}`;
}

function saveTasks() {
    localStorage.setItem('tasks', JSON.stringify(tasks));
}

renderTasks();
