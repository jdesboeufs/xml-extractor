import { Parser } from 'htmlparser2';
import { EventEmitter } from 'events';


function size(obj) {
    return Object.keys(obj).length;
}

function objIsEmpty(obj) {
    return size(obj) === 0;
}

export class ElementType {

    constructor() {
        this.extractables = {};
        this.currentPath = [];
    }

    initValue() {
        return {};
    }

    returnValue(obj) {
        return !objIsEmpty(obj) ? obj : undefined;
    }

    find(elementName) {
        this.currentPath.push(elementName);
        return this;
    }

    end() {
        this.currentPath.pop();
        return this;
    }

    validatesPath(pathNeeded, ctx) {
        let currentStack = ctx.extractor.eStack.slice(ctx.position);
        let result = true;
        let path = [].concat(pathNeeded);
        while (path.length > 0 && result) {
            const found = currentStack.indexOf(path[0]);
            if (found >= 0) {
                currentStack = currentStack.slice(found);
                path.shift();
            } else {
                result = false;
            }
        }
        return result;
    }

    extract(elementName, destinationKey, elementType = String) {
        this.extractables[elementName] = { destinationKey, elementType, path: [].concat(this.currentPath) };
        return this;
    }

    extractMany(elementName, destinationKey, elementType = String) {
        this.extractables[elementName] = { destinationKey, elementType, path: [].concat(this.currentPath), array: true };
        return this;
    }

    extractAttribute(elementName, attributeName, destinationKey) {
        this.extractables[elementName] = { destinationKey, String, attribute: attributeName, path: [].concat(this.currentPath) };
        return this;
    }

    onOpenTag(name, attributes, ctx) {
        const extractable = this.extractables[name];
        if (extractable && this.validatesPath(extractable.path, ctx)) {
            if (extractable.attribute && attributes[extractable.attribute]) {
                ctx.value[extractable.destinationKey] = attributes[extractable.attribute];
            } else {
                extractable.ctx = ctx.pushContext(extractable.elementType, () => this.finishExtraction(name, ctx));
            }
        }
    }

    onCloseTag(name, ctx) {
        // const extractable = this.extractables[name];
        // if (extractable) {
        //     this.finishExtraction(name, ctx); // Probably never called
        // }
    }

    onText(text, ctx) {
        const normalizedText = text.trim();
        if (normalizedText.length > 0) {
            console.log('Text not handled: %s', normalizedText);
        }
    }

    finishExtraction(name, ctx) {
        const extractable = this.extractables[name];
        const value = extractable.ctx.returnValue();
        if (value) {
            if (extractable.array) {
                if (!ctx.value[extractable.destinationKey]) {
                    ctx.value[extractable.destinationKey] = [];
                }
                ctx.value[extractable.destinationKey].push(value);
            } else {
                ctx.value[extractable.destinationKey] = value;
            }
        }
        extractable.ctx = undefined;
    }

}

const StringType = {
    initValue: () => '',
    returnValue: obj => obj.length > 0 ? obj : undefined,
    onText: (text, ctx) => ctx.value += (text.trim() || '')
};

const DateType = {
    initValue: () => '',
    returnValue: obj => new Date(obj),
    onText: (text, ctx) => ctx.value += (text.trim() || '')
};

const FloatType = {
    initValue: () => '',
    returnValue: obj => parseFloat(obj),
    onText: (text, ctx) => ctx.value += (text.trim() || '')
};

const IntegerType = {
    initValue: () => '',
    returnValue: obj => parseInt(obj, 10),
    onText: (text, ctx) => ctx.value += (text.trim() || '')
};

export class Context {

    constructor(extractor, type, position, onLeave) {
        this.extractor = extractor;
        this.type = type;
        this.position = position;
        this.onLeave = onLeave;
        this.value = type.initValue();
    }

    onOpenTag(name, attributes) {
        if (!this.type.onOpenTag) return;
        this.type.onOpenTag(name, attributes, this);
    }

    onCloseTag(name) {
        if (!this.type.onCloseTag) return;
        this.type.onCloseTag(name, this);
    }

    onText(text) {
        if (!this.type.onText) return;
        this.type.onText(text, this);
    }

    enter(attributes) {
        if (!this.type.onEnter) return;
        this.type.onEnter(attributes, this);
    }

    leave() {
        if (this.onLeave) this.onLeave();
    }

    returnValue() {
        return this.type.returnValue(this.value);
    }

    pushContext(typeName, onLeave) {
        return this.extractor.pushContext(typeName, onLeave);
    }

    popContext() {
        this.extractor.popContext;
        return this.extractor.currentContext;
    }

}

export class Extractor extends EventEmitter {

    constructor() {
        super();

        this.parser = new Parser({
            onopentag: (name, attrs) => this.onOpenTag(name, attrs),
            onclosetag: name => this.onCloseTag(name),
            ontext: text => this.onText(text)
        }, { xmlMode: true, decodeEntities: true });

        this.eStack = [];
        this.ctxStack = [];

        this.elementTypes = {};

        this
            .elementType(String, StringType)
            .elementType(Date, DateType)
            .elementType('Float', FloatType)
            .elementType('Integer', IntegerType);

        this.parser
            .on('drain', () => this.emit('drain'))
            .on('finish', () => this.emit('finish'))
            .on('pipe', (src) => this.emit('pipe', src))
            .on('unpipe', (src) => this.emit('unpipe', src))
            .on('error', (error) => this.emit('error', error));
    }

    elementType(name, definition) {
        if (definition) {
            this.elementTypes[name] = definition;
            return this;
        } else {
            this.elementTypes[name] = new ElementType();
            return this.elementTypes[name];
        }
    }

    pushContext(typeName, onLeave) {
        const type = this.elementTypes[typeName];
        const ctx = new Context(this, type, this.eStack.length, onLeave);
        this.ctxStack.push(ctx);
        return ctx;
    }

    popContext() {
        this.ctxStack.pop();
    }

    get currentContext() {
        return this.ctxStack[this.ctxStack.length - 1];
    }

    isRootContext() {
        return this.eStack.length === 0;
    }

    onOpenTag(name, attrs) {
        if (this.isRootContext()) {
            if (name in this.elementTypes) {
                this.pushContext(name);
                this.currentContext.enter(attrs);
            } else {
                throw new Error('Unknown element type: %s', name);
            }
        } else {
            // Propagation
            this.currentContext.onOpenTag(name, attrs);
        }

        this.eStack.push(name);
    }

    isLastContext() {
        return this.ctxStack.length === 1;
    }

    isLeavingCurrentContext() {
        return this.currentContext.position === this.eStack.length;
    }

    onCloseTag(name) {
        this.eStack.pop();

        if (this.isLeavingCurrentContext()) {
            this.currentContext.leave();

            if (this.isLastContext()) {
                this.emit('result', this.currentContext.returnValue())
            }

            this.popContext();
        } else {
            // Propagation
            this.currentContext.onCloseTag(name);
        }
    }

    onText(text) {
        if (!this.currentContext) return;

        // Propagation
        this.currentContext.onText(text);
    }

    write(chunk, encoding, callback) {
        this.parser.write(chunk, encoding, callback);
    }

    end(chunk, encoding, callback) {
        this.parser.end(chunk, encoding, callback);
    }

}
