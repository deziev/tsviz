import * as ts from "typescript";
import * as path from "path";
import { Element, Module, Class, Method, ImportedModule, Property, Visibility, QualifiedName, Lifetime } from "./ts-elements";
import { Collections } from "./extensions";

export function collectInformation(program: ts.Program, sourceFile: ts.SourceFile): Module {
    const typeChecker = program.getTypeChecker();
    
    let filename = sourceFile.fileName;
    filename = filename.substr(0, filename.lastIndexOf(".")); // filename without extension
    let moduleName  = path.basename(filename); // get module filename without directory
    
    let module = new Module(moduleName, null);
    module.path = path.dirname(filename);
    
    analyseNode(sourceFile, module);
    
    function analyseNode(node: ts.Node, currentElement: Element) {
        let childElement: Element;
        let skipChildren = false;
        switch (node.kind) {
            case ts.SyntaxKind.ModuleDeclaration:
                let moduleDeclaration = <ts.ModuleDeclaration> node;
                childElement = new Module(moduleDeclaration.name.text, currentElement, getVisibility(node));
                break;

            case ts.SyntaxKind.ImportEqualsDeclaration:
                let importEqualDeclaration = (<ts.ImportEqualsDeclaration> node);
                childElement = new ImportedModule(importEqualDeclaration.name.text, currentElement);
                break;
                
            case ts.SyntaxKind.ImportDeclaration:
                let importDeclaration = (<ts.ImportDeclaration> node);
                let moduleName = (<ts.StringLiteral> importDeclaration.moduleSpecifier).text;
                childElement = new ImportedModule(moduleName, currentElement);
                break;
                
            case ts.SyntaxKind.ClassDeclaration:
                let classDeclaration = <ts.ClassDeclaration> node;
                let classDef = new Class(classDeclaration.name.text, currentElement, getVisibility(node));
                classDef.isAbstract = checkIfAbstract(classDeclaration.modifiers);
                if (classDeclaration.heritageClauses) {
                    let extendsClause = Collections.firstOrDefault(classDeclaration.heritageClauses, c => c.token === ts.SyntaxKind.ExtendsKeyword);
                    if (extendsClause && extendsClause.types.length > 0) {
                        classDef.extends = getFullyQualifiedName(extendsClause.types[0]);
                    }
                }
                childElement = classDef;
                break;
            
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
            case ts.SyntaxKind.PropertyDeclaration:
                let propertyDeclaration = <ts.PropertyDeclaration> node;
                let property = new Property((<ts.Identifier>propertyDeclaration.name).text, currentElement, getVisibility(node), getLifetime(node));
                property.typeName = getTypeName(propertyDeclaration.type);
                switch (node.kind) {
                    case ts.SyntaxKind.GetAccessor:
                        property.hasGetter = true;
                        break;
                    case ts.SyntaxKind.SetAccessor:
                        property.hasSetter = true;
                }
                childElement = property;
                skipChildren = true;
                break;
                
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
                let functionDeclaration = <ts.Declaration> node;
                childElement = new Method((<ts.Identifier>functionDeclaration.name).text, currentElement, getVisibility(node), getLifetime(node));
                childElement.isAbstract = checkIfAbstract(functionDeclaration.modifiers);
                skipChildren = true;
                break;
                
        }
        
        if (childElement) {
            currentElement.addElement(childElement);
        }
        
        if (skipChildren) {
            return; // no need to inspect children
        }
        
        ts.forEachChild(node, (node) => analyseNode(node, childElement || currentElement));
    }

    function getTypeName(typeNode: ts.TypeNode): string {
        let kind = typeNode && typeNode.kind;
        switch (kind) {
            case ts.SyntaxKind.AnyKeyword:
                return "any";
            case ts.SyntaxKind.BooleanKeyword:
                return "boolean";
            case ts.SyntaxKind.NumberKeyword:
                return "number";
            case ts.SyntaxKind.StringKeyword:
                return "string";
            case ts.SyntaxKind.FunctionType:
                return "function";
            case ts.SyntaxKind.ArrayType:
                let arrayTypeNode = <ts.ArrayTypeNode> typeNode;
                return "Array&lt;" + arrayTypeNode.elementType.getFullText().trim() + "&gt;";
            case ts.SyntaxKind.TypeReference:
                let typeRefNode = <ts.TypeReferenceNode> typeNode;
                return typeRefNode.typeName.getFullText().trim();
            default: // undefined
                return String(kind);
        }
    }

    function checkIfAbstract(modifiers: ts.ModifiersArray): boolean {
        return !modifiers ? false :
            checkModifiersForFlag(modifiers, ts.SyntaxKind.AbstractKeyword);
    }
    
    function getFullyQualifiedName(expression: ts.ExpressionWithTypeArguments) {
        let symbol = typeChecker.getSymbolAtLocation(expression.expression);
        if (symbol) {
            let nameParts = typeChecker.getFullyQualifiedName(symbol).split(".");
            if (symbol.declarations.length > 0 && symbol.declarations[0].kind === ts.SyntaxKind.ImportSpecifier) {
                // symbol comes from an imported module
                // get the module name from the import declaration
                let importSpecifier = symbol.declarations[0];
                let moduleName = (<ts.StringLiteral> (<ts.ImportDeclaration> importSpecifier.parent.parent.parent).moduleSpecifier).text;
                nameParts.unshift(moduleName);
            } else {
                if (nameParts.length > 0 && nameParts[0].indexOf("\"") === 0) {
                    // if first name part has " then it should be a module name
                    let moduleName = nameParts[0].replace(/\"/g, ""); // remove " from module name
                    nameParts[0] = moduleName;
                }
            }
            return new QualifiedName(nameParts);
        }
        console.warn("Unable to resolve type: '" + expression.getText() + "'");
        return new QualifiedName(["unknown?"]);
    }
    
    function getVisibility(node: ts.Node) {
        if (node.modifiers) {
            if (checkModifiersForFlag(node.modifiers, ts.SyntaxKind.ProtectedKeyword)) {
                return Visibility.Protected;
            } else if (checkModifiersForFlag(node.modifiers, ts.SyntaxKind.PrivateKeyword)) {
                return Visibility.Private;
            } else if (checkModifiersForFlag(node.modifiers, ts.SyntaxKind.PublicKeyword)) {
                return Visibility.Public;
            } else if (checkModifiersForFlag(node.modifiers, ts.SyntaxKind.ExportKeyword)) {
                return Visibility.Public;
            }
        }
        switch (node.parent.kind) {
            case ts.SyntaxKind.ClassDeclaration:
                return Visibility.Public;
            case ts.SyntaxKind.ModuleDeclaration:
                return Visibility.Private;
        }
        return Visibility.Private;
    }

    function getLifetime(node: ts.Node) {
        if (node.modifiers) {
            if (checkModifiersForFlag(node.modifiers, ts.SyntaxKind.StaticKeyword)) {
                return Lifetime.Static;
            }
        }
        return Lifetime.Instance;
    }

    function checkModifiersForFlag(modifiers: ts.ModifiersArray, flag: number) {
        return modifiers.some(function(modifier): boolean {
                return hasModifierSet(modifier.kind, flag);
        });
    }

    function hasModifierSet(value: number, modifier: number) {
        return value && modifier && (value === modifier);
    }

    return module;
}