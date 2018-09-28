import * as fs from 'fs';
import * as ts from 'typescript';

const inputFile = process.argv[2];
const sourceCode = fs.readFileSync(inputFile, 'utf-8');
const sourceFile = ts.createSourceFile(inputFile, sourceCode, ts.ScriptTarget.Latest, true);

/* tslint:disable:no-reserved-keywords */
const CUSTOM_FUNCTION = 'customfunction'; // case insensitive @CustomFunction tag to identify custom functions in JSDoc
const HELPURL_PARAM = 'helpurl';

let errorFound = false;
let errorLogFile = [];
let skippedFunctions = [];

const TYPE_MAPPINGS = {
    [ts.SyntaxKind.NumberKeyword]: 'number',
    [ts.SyntaxKind.StringKeyword]: 'string',
    [ts.SyntaxKind.BooleanKeyword]: 'boolean',
};

/**
 * Takes the sourcefile and attempts to parse the functions information
 * @param sourceFile source file containing the custom functions
 */
function parseTree(sourceFile: ts.SourceFile): ICFVisualFunctionMetadata[] {
    const metadata: ICFVisualFunctionMetadata[] = [];
    console.log("start parse");
    visit(sourceFile);
    return metadata;

    function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node)) {
            if (node.parent && node.parent.kind === ts.SyntaxKind.SourceFile) {
                const func = node as ts.FunctionDeclaration;
                const isCF =
                    ts
                        .getJSDocTags(func)
                        .filter(
                        (tag: ts.JSDocTag) =>
                            (tag.tagName.escapedText as string).toLowerCase() === CUSTOM_FUNCTION
                        ).length > 0;

                if (isCF) {
                    const jsDocParamInfo = getJSDocParams(func);

                    const [lastParameter] = func.parameters.slice(-1);
                    const isStreamingFunction = isLastParameterStreaming(lastParameter);
                    const paramsToParse = isStreamingFunction
                        ? func.parameters.slice(0, func.parameters.length - 1)
                        : func.parameters.slice(0, func.parameters.length);

                    const parameters = paramsToParse
                        .map((p: ts.ParameterDeclaration) => {
                            const name = (p.name as ts.Identifier).text;

                            return {
                                name,
                                description: jsDocParamInfo[name],
                                type: getParamType(p.type),
                                dimensionality: getParamDim(p.type)
                            };
                        })
                        .filter(meta => meta);

                    let description;
                    if ((func as any).jsDoc) {
                        description = (func as any).jsDoc[0].comment;
                    }

                    let resultType = "any";
                    let resultDim = "scalar";

                    if (isStreamingFunction) {
                        const lastParameterType = lastParameter.type as ts.TypeReferenceNode;
                        if (!lastParameterType.typeArguments || lastParameterType.typeArguments.length !== 1) {
                            console.log("The 'CustomFunctions.StreamingHandler' needs to be passed in a single result type (e.g., 'CustomFunctions.StreamingHandler < number >')");
                            return;
                        }
                        let returnType = func.type as ts.TypeReferenceNode;
                        if (returnType && returnType.getFullText().trim() !== 'void') {
                            console.log(`A streaming function should not have a return type.  Instead, its type should be based purely on what's inside "CustomFunctions.StreamingHandler<T>".`);
                            return;
                        }
                        resultType = getParamType(lastParameterType.typeArguments[0]);
                        resultDim = getParamDim(lastParameterType.typeArguments[0]);
                    } else if (func.type) {
                        if (func.type.kind === ts.SyntaxKind.TypeReference &&
                            (func.type as ts.TypeReferenceNode).typeName.getText() === 'Promise' &&
                            (func.type as ts.TypeReferenceNode).typeArguments &&
                            (func.type as ts.TypeReferenceNode).typeArguments.length === 1
                        ) {
                            resultType = getParamType((func.type as ts.TypeReferenceNode).typeArguments[0]);
                            resultDim = getParamDim((func.type as ts.TypeReferenceNode).typeArguments[0]);
                        }
                        else {
                            resultType = getParamType(func.type);
                            resultDim = getParamDim(func.type);
                        }
                    } else {
                        console.log("No return type specificed. This could be .js filetype, so continue.");
                    }

                    let result = {
                        type: resultType,
                        dimensionality: resultDim
                    }

                    let options = {
                        sync: false,
                        cancelable: isStreamingFunction,
                        stream: isStreamingFunction
                    };

                    const funcName = func.name.text;
                    const metadataItem: ICFVisualFunctionMetadata = {
                        name: funcName,
                        id: funcName,
                        helpurl: getHelpUrl(func),
                        description,
                        parameters,
                        result,
                        options,
                    };

                     metadata.push(metadataItem);
                }
                else {
                    //Function was skipped
                    skippedFunctions.push(func.name.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
}

/**
 * Returns the @helpurl of the JSDo
 * @param node Node
 */
function getHelpUrl(node: ts.Node): string {
    var helpurl = "";
    ts.getJSDocTags(node).forEach(
        (tag: ts.JSDocTag) => {
            if ((tag.tagName.escapedText as string).toLowerCase() === HELPURL_PARAM) {
                if (tag.comment) {
                    helpurl = tag.comment;
                }
            }
        }
    );
    return helpurl;
}

/**
* This method will parse out all of the @param tags of a JSDoc and return a dictionary
* @param node - The function to parse the JSDoc params from
*/
function getJSDocParams(node: ts.Node): { [key: string]: string } {
    const jsDocParamInfo = {};

    ts.getAllJSDocTagsOfKind(node, ts.SyntaxKind.JSDocParameterTag).forEach(
        (tag: ts.JSDocParameterTag) => {
            if (tag.comment) {
                const comment = (tag.comment.startsWith('-')
                    ? tag.comment.slice(1)
                    : tag.comment
                ).trim();

                jsDocParamInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = comment;
            }
            else {
                //Description is missing so add empty string
                jsDocParamInfo[(tag as ts.JSDocPropertyLikeTag).name.getFullText()] = "";
            }
        }
    );

    return jsDocParamInfo;
}

/**
 * Determines if the last parameter is streaming
 * @param param ParameterDeclaration
 */
function isLastParameterStreaming(param?: ts.ParameterDeclaration): boolean {
    const isTypeReferenceNode = param && param.type && ts.isTypeReferenceNode(param.type);
    if (!isTypeReferenceNode) {
        return false;
    }

    const typeRef = param.type as ts.TypeReferenceNode;
    return (
        typeRef.typeName.getText() === 'CustomFunctions.StreamingHandler' ||
        typeRef.typeName.getText() === 'IStreamingCustomFunctionHandler' /* older version*/
    );
}

/**
 * Gets the parameter type of the node
 * @param t TypeNode
 */
function getParamType(t: ts.TypeNode): string {
    let type = 'any';
    //Only get type for typescript files.  js files will return any for all types
    if (t) {
        let kind = t.kind;
        if (ts.isTypeReferenceNode(t)) {
            const arrTr = t as ts.TypeReferenceNode;
            if (arrTr.typeName.getText() !== 'Array') {
                logError("Invalid type: " + arrTr.typeName.getText());
                return;
            }
            const isArrayWithTypeRefWithin = validateArray(t) && ts.isTypeReferenceNode(arrTr.typeArguments[0]);
            if (isArrayWithTypeRefWithin) {
                const inner = arrTr.typeArguments[0] as ts.TypeReferenceNode;
                if (!validateArray(inner)) {
                    logError("Invalid type array: " + inner.getText());
                    return;
                }
                kind = inner.typeArguments[0].kind;
            }
        }
        else if (ts.isArrayTypeNode(t)) {
            const inner = (t as ts.ArrayTypeNode).elementType;
            if (!ts.isArrayTypeNode(inner)) {
                logError("Invalid array type node: " + inner.getText());
                return;
            }
            // Expectation is that at this point, "kind" is a primitive type (not 3D array).
            // However, if not, the TYPE_MAPPINGS check below will fail.
            kind = inner.elementType.kind;
        }

        type = TYPE_MAPPINGS[kind];
        if (!type) {
            logError("Type doesn't match mappings");
        }
    }
    return type;
}

/**
 * Get the parameter dimensionality of the node
 * @param t TypeNode
 */
function getParamDim(t: ts.TypeNode): string {
    let dimensionality: CustomFunctionsSchemaDimensionality = 'scalar';
    if (t) {
        if (ts.isTypeReferenceNode(t) || ts.isArrayTypeNode(t)) {
            dimensionality = 'matrix';
        }
    }
    return dimensionality;
}

/**
 * This function will return `true` for `Array<[object]>` and `false` otherwise.
 * @param a - TypeReferenceNode
 */
function validateArray(a: ts.TypeReferenceNode) {
    return (
        a.typeName.getText() === 'Array' && a.typeArguments && a.typeArguments.length === 1
    );
}

/**
 * Log containing all the errors found while parsing
 * @param error Error string to add to the log
 */
function logError(error: string) {
    errorLogFile.push(error);
    errorFound = true;
}

var rootObject = new Object();
//Parse the source file
rootObject.functions = parseTree(sourceFile);

if (!errorFound) {

    fs.writeFile("./functions.json", JSON.stringify(rootObject), (err) => {
        if (err) {
            console.error(err);
            return;
        };
        console.log("functions.json created for file: " + inputFile);
    }
    );
    if (skippedFunctions.length > 0) {
        console.log("The following functions were skipped.");
        for (let func in skippedFunctions) {
            console.log(skippedFunctions[func]);
        }
    }
} else {
    console.log("There was one of more errors. We couldn't parse your file: " + inputFile);
    for (let err in errorLogFile) {
        console.log(errorLogFile[err]);
    }
}
