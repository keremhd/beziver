const Genetic = require('genetic-js');
import { Bezier } from "bezier-js";

(() => {

const InputFileUpload = document.getElementById("file-upload");

const CanvasResult = document.getElementById('result-canvas');
const ButtonRandom = document.getElementById('random');
const ButtonFit = document.getElementById('fit');


InputFileUpload.addEventListener("change", onChange);
ButtonRandom.addEventListener("click", onRandom);
ButtonFit.addEventListener("click", onFit);

var InputCanvas = document.getElementById('input-canvas');
InputCanvas.width = 100;
InputCanvas.height = 100;

async function onChange() {
    const file = InputFileUpload.files;
    if (file) {
        const fileReader = new FileReader();

        fileReader.onload = async (event) => {
            let img = new Image();
            img.src = event.target.result;
            img.onload = async () => {
                let ctx = InputCanvas.getContext("2d");
                let w = InputCanvas.width;
                let h = InputCanvas.height;
                
                ctx.drawImage(img,0,0,w,h);

                let imgData = ctx.getImageData(0,0,w,h);
                let data = imgData.data;
                for (var idx = 0; idx < data.length; idx += 4) {
                    let avg = Math.round((data[idx] + data[idx+1] + data[idx+2]) / 3);
                    data[idx] = avg;
                    data[idx+1] = avg;
                    data[idx+2] = avg;
                    data[idx+3] = 255;
                }
                ctx.putImageData(imgData, 0, 0);
            }
        };
        
        fileReader.readAsDataURL(file[0]);
    }
}

let newControlGrid = (N, randomize) => {

    let newPoint = (x,y,z) => {
        return { x:x, y:y, z:z };
    }

    var points = [];

    for (var j = 0; j < N; j++) {
        points[j] = [];
        for (var i = 0; i < N; i++) {
            points[j][i] = newPoint(
                i/(N-1) + (randomize ? (.5-Math.random()) : 0.0),
                j/(N-1) + (randomize ? ( .5-Math.random()) : 0.0),
                (randomize ? Math.random() : 0.0));
        }
    }
    
    return points;
}

function drawControlGrid(canvas, controlGrid, $fn) {

    let drawQuad = (ctx,W,H,p1,p2,p3,p4) => {
        var z = (p1.z + p2.z + p3.z + p4.z) / 4;
        if (z < 0) z = 0;
        if (z > 1) z = 1;
    
        const grayTone = Math.round(z*255);
        ctx.fillStyle = `rgb(${grayTone} ${grayTone} ${grayTone})`;
    
        ctx.beginPath();
        ctx.moveTo(p1.x * W - .5, p1.y * H - .5);
        ctx.lineTo(p2.x * W + .5, p2.y * H - .5);
        ctx.lineTo(p3.x * W + .5, p3.y * H + .5);
        ctx.lineTo(p4.x * W - .5, p4.y * H + .5);
        ctx.closePath();
        ctx.fill();
    }

    var ctx = canvas.getContext("2d");
    var W = canvas.width;
    var H = canvas.height;
    var N = controlGrid.length;

    var luts = [];
    for (var j = 0; j < N; j++) {
        luts[j] = new Bezier(controlGrid[j]).getLUT($fn);
    }

    var pointMap = [];
    for (var y = 0; y < $fn; y++) {
        pointMap[y] = [];
        for (var x = 0; x < $fn; x++) {
            pointMap[y][x] = null;
        }
    }

    for (var x = 0; x < $fn; x++) {
        var midPoints = [];
        for (var j = 0; j < N; j++) {
            midPoints[j] = luts[j][x];
        }

        var midLuts = new Bezier(midPoints).getLUT($fn);

        for (var y = 0; y < $fn; y++) {
            pointMap[y][x] = midLuts[y];
        }
    }

    for (var x1 = 0; x1 < $fn-1; x1++) {
        for (var y1 = 0; y1 < $fn-1; y1++) {
            var x2 = x1+1;
            var y2 = y1+1;

            var p11 = pointMap[y1][x1];
            var p12 = pointMap[y1][x2];
            var p21 = pointMap[y2][x1];
            var p22 = pointMap[y2][x2];

            drawQuad(ctx, W, H, p11, p12, p22, p21);
        }
    }
}

function calculateDistanceCanvas(canvas1, canvas2, numberOfSamples) {
    var arr1 = canvas2array(canvas1);
    var arr2 = canvas2array(canvas2);
    return calculateDistance(arr1, arr2, numberOfSamples);
}

function calculateDistance(arr1, arr2, numberOfSamples) {
    var sumError = 0.0;
    for (var i = 0; i < numberOfSamples; i++) {
        var xy = Math.random();

        let offset1 = Math.round(xy * (arr1.length-1));
        let offset2 = Math.round(xy * (arr2.length-1));

        let v1 = arr1[offset1];
        let v2 = arr2[offset2];
        
        sumError += (v1-v2)**2;
    }

    return sumError/numberOfSamples;
}

function canvas2array(canvas) {
    var imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    var arr = []
    let d = imageData.data;
    for (var i = 0; i < imageData.width * imageData.height; i++) {
        arr[i] = (d[4*i] + d[4*i+1] + d[4*i+2])/3;
    }

    return arr;
}

async function onRandom() {
    var W = 100;
    var H = 100;
    var outputCanvas = new OffscreenCanvas(W, H);
    let $fn = 100;

    var points = newControlGrid(4, true);
    drawControlGrid(outputCanvas, points, $fn);

    console.log(calculateDistanceCanvas(InputCanvas, outputCanvas, 100));

    InputCanvas.width = W;
    InputCanvas.height = H;
    InputCanvas
        .getContext("2d")
        .drawImage(outputCanvas, 0, 0);
}

async function onFit() {
    var genetic = Genetic.create();

    genetic.newControlGrid = newControlGrid;
    genetic.drawControlGrid = drawControlGrid;
    genetic.calculateDistance = calculateDistance;
    genetic.inputArray = canvas2array(InputCanvas);
    genetic.canvas2array = canvas2array;
    
    genetic.seed = () => {
        return this.newControlGrid(4, true);
    }

    genetic.fitness = (grid) => {
        var canvas = new OffscreenCanvas(100, 100);
        this.drawControlGrid(canvas, grid, 10);
        
        return this.calculateDistance(this.inputArray, this.canvas2array(canvas), 1000);
    }

    genetic.mutate = (grid) => {
        var j = Math.round(Math.random() * (grid.length-1));
        var i = Math.round(Math.random() * (grid[j].length-1));

        let alpha = 1;
        let dx = alpha * (Math.random() - 0.5);
        let dy = alpha * (Math.random() - 0.5);
        let dz = alpha * (Math.random() - 0.5);
        
        for (var a = -1; a <= 1; a++) {
            for (var b = -1; b <= 1; b++) {
                if (j+a >= 0 && j+a < grid.length &&
                    i+b >= 0 && i+b < grid[j+a].length) {
                    var p = grid[j+a][i+b];
                    p.x += dx;
                    p.y += dy;
                    p.z += dz;
                }
            }
        }
        

        return grid;
    }

    genetic.crossover = (grid1, grid2) => {
        for (var k = 0; k < 10; k++) {
            var j = Math.round(Math.random() * (grid1.length-1));
            var i = Math.round(Math.random() * (grid1[j].length-1));

            var p1 = grid1[j][i];
            grid1[j][i] = grid2[j][i];
            grid2[j][i] = p1;
        }

        return [grid1, grid2];
    }

    genetic.optimize = Genetic.Optimize.Minimize;
    genetic.select1 = Genetic.Select1.RandomLinearRank;
    genetic.select2 = Genetic.Select2.FittestRandom;

    genetic.generation = (pop, gen, stats) => {
        return (pop[0].fitness > 100);
    }

    genetic.notification = (pop, gen, stats, isFinished) => {
        console.log(gen, pop[0].fitness, stats);
        
        if(isFinished) {
            var canvas = new OffscreenCanvas(100, 100);
            drawControlGrid(canvas, pop[0].entity, 20);

            let ctx = CanvasResult.getContext("2d");
            ctx.clearRect(0,0, CanvasResult.width, CanvasResult.height);
            ctx.drawImage(canvas, 0, 0);

            console.log(pop);
        }
    }

    genetic.evolve({webWorkers: false, iterations:100});
}

})();
