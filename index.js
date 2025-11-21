const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs').promises;
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Persistent storage for tasks
const TASKS_FILE = 'automation_tasks.json';

class PersistentAutomationState {
    constructor(taskId) {
        this.taskId = taskId;
        this.running = false;
        this.messageCount = 0;
        this.startTime = null;
        this.config = null;
        this.lastUpdated = new Date();
        this.processId = null;
        this.messageRotationIndex = 0;
    }
}

// Task management
class TaskManager {
    constructor() {
        this.tasks = new Map();
        this.loadTasks();
    }

    async loadTasks() {
        try {
            const data = await fs.readFile(TASKS_FILE, 'utf8');
            const savedTasks = JSON.parse(data);
            const currentTime = new Date();
            
            for (const [taskId, taskData] of Object.entries(savedTasks)) {
                const task = Object.assign(new PersistentAutomationState(taskId), taskData);
                task.lastUpdated = new Date(task.lastUpdated);
                
                // Only load tasks that are not too old (last 24 hours)
                if (currentTime - task.lastUpdated < 24 * 60 * 60 * 1000) {
                    this.tasks.set(taskId, task);
                }
            }
            console.log(`Loaded ${this.tasks.size} tasks from storage`);
        } catch (error) {
            console.log('Error loading tasks:', error);
        }
    }

    async saveTasks() {
        try {
            const tasksObj = Object.fromEntries(this.tasks);
            await fs.writeFile(TASKS_FILE, JSON.stringify(tasksObj, null, 2));
        } catch (error) {
            console.log('Error saving tasks:', error);
        }
    }

    addTask(taskId, taskState) {
        this.tasks.set(taskId, taskState);
        this.saveTasks();
    }

    getTask(taskId) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.lastUpdated = new Date();
            this.saveTasks();
        }
        return task;
    }

    updateTask(taskId, updates) {
        const task = this.tasks.get(taskId);
        if (task) {
            Object.assign(task, updates);
            task.lastUpdated = new Date();
            this.saveTasks();
        }
    }

    removeTask(taskId) {
        this.tasks.delete(taskId);
        this.saveTasks();
    }

    getAllTasks() {
        return new Map(this.tasks);
    }
}

// Global task manager
const taskManager = new TaskManager();

function generateTaskId() {
    const randomString = Math.random().toString(36).substring(2, 18);
    const hash = crypto.createHash('sha256').update(randomString).digest('hex').substring(0, 16).toUpperCase();
    return `RAGHAV-E2E-${hash}`;
}

function logMessage(msg, automationStateObj = null) {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMsg = `[${timestamp}] ${msg}`;
    console.log(formattedMsg);
}

async function findMessageInput(page, processId, automationStateObj = null) {
    logMessage(`${processId}: Finding message input...`, automationStateObj);
    await page.waitForTimeout(10000);

    try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(2000);
    } catch (error) {
        // Ignore scroll errors
    }

    try {
        const pageTitle = await page.title();
        const pageUrl = page.url();
        logMessage(`${processId}: Page Title: ${pageTitle}`, automationStateObj);
        logMessage(`${processId}: Page URL: ${pageUrl}`, automationStateObj);
    } catch (error) {
        logMessage(`${processId}: Could not get page info: ${error}`, automationStateObj);
    }

    const messageInputSelectors = [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[aria-label*="message" i][contenteditable="true"]',
        'div[aria-label*="Message" i][contenteditable="true"]',
        'div[contenteditable="true"][spellcheck="true"]',
        '[role="textbox"][contenteditable="true"]',
        'textarea[placeholder*="message" i]',
        'div[aria-placeholder*="message" i]',
        'div[data-placeholder*="message" i]',
        '[contenteditable="true"]',
        'textarea',
        'input[type="text"]'
    ];

    logMessage(`${processId}: Trying ${messageInputSelectors.length} selectors...`, automationStateObj);

    for (let idx = 0; idx < messageInputSelectors.length; idx++) {
        const selector = messageInputSelectors[idx];
        try {
            const elements = await page.$$(selector);
            logMessage(`${processId}: Selector ${idx + 1}/${messageInputSelectors.length} "${selector.substring(0, 50)}..." found ${elements.length} elements`, automationStateObj);

            for (const element of elements) {
                try {
                    const isEditable = await page.evaluate(el => {
                        return el.contentEditable === 'true' ||
                            el.tagName === 'TEXTAREA' ||
                            el.tagName === 'INPUT';
                    }, element);

                    if (isEditable) {
                        logMessage(`${processId}: Found editable element with selector #${idx + 1}`, automationStateObj);

                        try {
                            await element.click();
                            await page.waitForTimeout(500);
                        } catch (error) {
                            // Ignore click errors
                        }

                        const elementText = await page.evaluate(el => {
                            return el.placeholder || 
                                   el.getAttribute('aria-label') || 
                                   el.getAttribute('aria-placeholder') || '';
                        }, element);

                        const keywords = ['message', 'write', 'type', 'send', 'chat', 'msg', 'reply', 'text', 'aa'];
                        const hasKeyword = keywords.some(keyword => 
                            elementText.toLowerCase().includes(keyword)
                        );

                        if (hasKeyword) {
                            logMessage(`${processId}: ✅ Found message input with text: ${elementText.substring(0, 50)}`, automationStateObj);
                            return element;
                        } else if (idx < 10) {
                            logMessage(`${processId}: ✅ Using primary selector editable element (#${idx + 1})`, automationStateObj);
                            return element;
                        } else if (selector === '[contenteditable="true"]' || selector === 'textarea' || selector === 'input[type="text"]') {
                            logMessage(`${processId}: ✅ Using fallback editable element`, automationStateObj);
                            return element;
                        }
                    }
                } catch (error) {
                    logMessage(`${processId}: Element check failed: ${error.message.substring(0, 50)}`, automationStateObj);
                    continue;
                }
            }
        } catch (error) {
            continue;
        }
    }

    try {
        const pageSource = await page.content();
        logMessage(`${processId}: Page source length: ${pageSource.length} characters`, automationStateObj);
        if (pageSource.toLowerCase().includes('contenteditable')) {
            logMessage(`${processId}: Page contains contenteditable elements`, automationStateObj);
        } else {
            logMessage(`${processId}: No contenteditable elements found in page`, automationStateObj);
        }
    } catch (error) {
        // Ignore page source errors
    }

    return null;
}

async function setupBrowser(automationStateObj = null) {
    logMessage('Setting up Chrome browser...', automationStateObj);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--window-size=1920,1080',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        ]
    });

    logMessage('Chrome browser setup completed successfully!', automationStateObj);
    return browser;
}

function getNextMessage(messages, automationStateObj = null) {
    if (!messages || messages.length === 0) {
        return 'Hello!';
    }

    if (automationStateObj) {
        const message = messages[automationStateObj.messageRotationIndex % messages.length];
        automationStateObj.messageRotationIndex += 1;
        return message;
    } else {
        return messages[0];
    }
}

async function sendMessages(config, automationStateObj, processId = 'AUTO-1') {
    let browser = null;
    let page = null;
    
    try {
        logMessage(`${processId}: Starting automation...`, automationStateObj);
        browser = await setupBrowser(automationStateObj);
        page = await browser.newPage();
        
        await page.setViewport({ width: 1920, height: 1080 });

        logMessage(`${processId}: Navigating to Facebook...`, automationStateObj);
        await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
        await page.waitForTimeout(8000);

        if (config.cookies && config.cookies.trim()) {
            logMessage(`${processId}: Adding cookies...`, automationStateObj);
            const cookieArray = config.cookies.split(';');
            const cookies = [];

            for (const cookie of cookieArray) {
                const cookieTrimmed = cookie.trim();
                if (cookieTrimmed) {
                    const firstEqualIndex = cookieTrimmed.indexOf('=');
                    if (firstEqualIndex > 0) {
                        const name = cookieTrimmed.substring(0, firstEqualIndex).trim();
                        const value = cookieTrimmed.substring(firstEqualIndex + 1).trim();
                        cookies.push({
                            name: name,
                            value: value,
                            domain: '.facebook.com',
                            path: '/'
                        });
                    }
                }
            }

            await page.setCookie(...cookies);
        }

        if (config.chatId) {
            const chatId = config.chatId.trim();
            logMessage(`${processId}: Opening conversation ${chatId}...`, automationStateObj);
            await page.goto(`https://www.facebook.com/messages/t/${chatId}`, { waitUntil: 'networkidle2' });
        } else {
            logMessage(`${processId}: Opening messages...`, automationStateObj);
            await page.goto('https://www.facebook.com/messages', { waitUntil: 'networkidle2' });
        }

        await page.waitForTimeout(15000);

        const messageInput = await findMessageInput(page, processId, automationStateObj);

        if (!messageInput) {
            logMessage(`${processId}: Message input not found!`, automationStateObj);
            taskManager.updateTask(automationStateObj.taskId, { running: false });
            return 0;
        }

        const delay = parseInt(config.delay);
        let messagesSent = 0;
        const messagesList = config.messages.split('\n')
            .map(msg => msg.trim())
            .filter(msg => msg);

        if (messagesList.length === 0) {
            messagesList.push('Hello!');
        }

        while (automationStateObj.running) {
            const baseMessage = getNextMessage(messagesList, automationStateObj);
            const messageToSend = config.namePrefix ? 
                `${config.namePrefix} ${baseMessage}` : baseMessage;

            try {
                // Clear and type the message
                await messageInput.click({ clickCount: 3 }); // Select all
                await page.keyboard.press('Backspace');
                await messageInput.type(messageToSend, { delay: 100 });

                await page.waitForTimeout(1000);

                // Try to find and click send button
                const sendButtonClicked = await page.evaluate(() => {
                    const sendButtons = document.querySelectorAll(
                        '[aria-label*="Send" i]:not([aria-label*="like" i]), [data-testid="send-button"]'
                    );

                    for (const btn of sendButtons) {
                        if (btn.offsetParent !== null) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (!sendButtonClicked) {
                    logMessage(`${processId}: Send button not found, using Enter key...`, automationStateObj);
                    await messageInput.press('Enter');
                    logMessage(`${processId}: ✅ Sent via Enter: "${messageToSend.substring(0, 30)}..."`, automationStateObj);
                } else {
                    logMessage(`${processId}: ✅ Sent via button: "${messageToSend.substring(0, 30)}..."`, automationStateObj);
                }

                messagesSent += 1;
                automationStateObj.messageCount = messagesSent;

                // Update task state frequently
                taskManager.updateTask(automationStateObj.taskId, {
                    messageCount: messagesSent
                });

                logMessage(`${processId}: Message #${messagesSent} sent. Waiting ${delay}s...`, automationStateObj);
                await page.waitForTimeout(delay * 1000);

            } catch (error) {
                logMessage(`${processId}: Send error: ${error.message.substring(0, 100)}`, automationStateObj);
                await page.waitForTimeout(5000);
            }
        }

        logMessage(`${processId}: Automation stopped. Total messages: ${messagesSent}`, automationStateObj);
        return messagesSent;

    } catch (error) {
        logMessage(`${processId}: Fatal error: ${error.message}`, automationStateObj);
        taskManager.updateTask(automationStateObj.taskId, { running: false });
        return 0;
    } finally {
        if (browser) {
            try {
                await browser.close();
                logMessage(`${processId}: Browser closed`, automationStateObj);
            } catch (error) {
                // Ignore close errors
            }
        }
        // Final update when task completes
        taskManager.updateTask(automationStateObj.taskId, {
            running: false,
            messageCount: automationStateObj.messageCount
        });
    }
}

function startAutomationTask(config) {
    const taskId = generateTaskId();
    const automationState = new PersistentAutomationState(taskId);
    automationState.running = true;
    automationState.startTime = Date.now();
    automationState.config = config;
    automationState.processId = taskId;

    // Store the task
    taskManager.addTask(taskId, automationState);

    // Start the automation (non-blocking)
    sendMessages(config, automationState, taskId).catch(error => {
        console.error(`Automation task ${taskId} failed:`, error);
    });

    return taskId;
}

function stopAutomationTask(taskId) {
    const task = taskManager.getTask(taskId);
    if (task) {
        task.running = false;
        taskManager.updateTask(taskId, { running: false });
        return true;
    }
    return false;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/start_automation', (req, res) => {
    const config = {
        chatId: req.body.chat_id || '',
        namePrefix: req.body.name_prefix || '',
        delay: parseInt(req.body.delay) || 30,
        cookies: req.body.cookies || '',
        messages: req.body.messages || ''
    };

    // Generate task ID and start automation
    const taskId = startAutomationTask(config);

    // Return response
    res.json({
        status: 'started',
        message: 'Automation started successfully!',
        task_id: taskId,
        redirect_url: `/status/${taskId}`
    });
});

app.get('/status/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    const task = taskManager.getTask(taskId);
    
    if (!task) {
        // Try to find task in all tasks (case insensitive)
        const allTasks = taskManager.getAllTasks();
        let foundTask = null;
        
        for (const [tid, t] of allTasks) {
            if (tid.toUpperCase() === taskId.toUpperCase()) {
                foundTask = t;
                break;
            }
        }

        if (!foundTask) {
            res.status(404).sendFile(path.join(__dirname, 'public', 'task_not_found.html'));
            return;
        }
        
        task = foundTask;
    }

    res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

app.post('/api/stop_automation/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    if (stopAutomationTask(taskId)) {
        res.json({ status: 'stopped', message: `Automation task ${taskId} stopped!` });
    } else {
        res.status(404).json({ status: 'error', message: 'Task not found' });
    }
});

app.get('/api/get_status/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    const task = taskManager.getTask(taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    const status = task.running ? "running" : "stopped";
    
    res.json({
        status: status,
        task_id: task.taskId
    });
});

// Save tasks on exit
process.on('SIGINT', async () => {
    await taskManager.saveTasks();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await taskManager.saveTasks();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});